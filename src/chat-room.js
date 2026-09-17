import { DurableObject } from "cloudflare:workers";

export class FutbolXChatRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;

    this.lastMessageTimes = new Map();

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_settings (
        event_id TEXT PRIMARY KEY,
        is_closed INTEGER NOT NULL DEFAULT 0,
        slow_mode INTEGER NOT NULL DEFAULT 0,
        announcement TEXT,
        pinned_message_id TEXT
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        message TEXT NOT NULL,
        event_id TEXT NOT NULL,
        is_owner INTEGER NOT NULL DEFAULT 0,
        is_mod INTEGER NOT NULL DEFAULT 0,
        reply_to_username TEXT,
        reply_to_msg TEXT,
        reply_to_id TEXT,
        created_at TEXT NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_event_created
      ON messages(event_id, created_at)
    `);
  }


  /* =========================================
     HTTP
  ========================================= */

  async fetch(request) {

    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      url.pathname === "/ws"
    ) {
      return this.handleWebSocket(request);
    }

    return new Response("FutbolX Chat Room", {
      status: 200
    });
  }


  /* =========================================
     WEBSOCKET CONNECTION
  ========================================= */

  async handleWebSocket(request) {

    if (
      request.headers.get("Upgrade")?.toLowerCase() !==
      "websocket"
    ) {
      return new Response(
        "WebSocket upgrade required",
        { status: 426 }
      );
    }

    const pair = new WebSocketPair();

    const client = pair[0];
    const server = pair[1];

    const url = new URL(request.url);

    const eventID =
      url.searchParams.get("event") || "lobby";

    server.serializeAttachment({
      eventID,
      connectedAt: Date.now(),
      username: null
    });

    this.ctx.acceptWebSocket(server);

    const settings =
      this.getRoomSettings(eventID);

    const messages =
      this.getMessages(eventID);

    server.send(JSON.stringify({
      type: "room_init",
      eventID,
      settings,
      messages
    }));

    this.broadcastPresence();

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }


  /* =========================================
     ROOM SETTINGS
  ========================================= */

  getRoomSettings(eventID) {

    const rows = this.sql.exec(`
      SELECT
        event_id,
        is_closed,
        slow_mode,
        announcement,
        pinned_message_id
      FROM room_settings
      WHERE event_id = ?
      LIMIT 1
    `, eventID).toArray();

    if (!rows.length) {
      return {
        event_id: eventID,
        is_closed: false,
        slow_mode: 0,
        announcement: null,
        pinned_message_id: null
      };
    }

    const row = rows[0];

    return {
      event_id: row.event_id,
      is_closed: !!row.is_closed,
      slow_mode: Number(row.slow_mode || 0),
      announcement: row.announcement,
      pinned_message_id: row.pinned_message_id
    };
  }


  saveRoomSettings(eventID, settings) {

    const current =
      this.getRoomSettings(eventID);

    const next = {
      ...current,
      ...settings
    };

    this.sql.exec(`
      INSERT INTO room_settings (
        event_id,
        is_closed,
        slow_mode,
        announcement,
        pinned_message_id
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_id)
      DO UPDATE SET
        is_closed = excluded.is_closed,
        slow_mode = excluded.slow_mode,
        announcement = excluded.announcement,
        pinned_message_id = excluded.pinned_message_id
    `,
      eventID,
      next.is_closed ? 1 : 0,
      Number(next.slow_mode || 0),
      next.announcement || null,
      next.pinned_message_id || null
    );

    return this.getRoomSettings(eventID);
  }


  /* =========================================
     MESSAGES
  ========================================= */

  getMessages(eventID) {

    return this.sql.exec(`
      SELECT *
      FROM messages
      WHERE event_id = ?
      ORDER BY created_at ASC
      LIMIT 100
    `, eventID).toArray();
  }


  /* =========================================
     BROADCAST
  ========================================= */

  broadcast(payload, exclude = null) {

    const message =
      JSON.stringify(payload);

    for (const socket of this.ctx.getWebSockets()) {

      if (socket === exclude) {
        continue;
      }

      try {
        socket.send(message);
      } catch (error) {
        console.error(
          "Broadcast error:",
          error
        );
      }
    }
  }


  broadcastPresence() {

    this.broadcast({
      type: "presence",
      count: this.ctx.getWebSockets().length
    });
  }


  broadcastSettings(eventID) {

    this.broadcast({
      type: "room_settings",
      settings: this.getRoomSettings(eventID)
    });
  }


  /* =========================================
     USER PROFILE / PERMISSIONS
  ========================================= */

  async getUserProfile(username) {

    if (!username) {
      return null;
    }

    try {

      const id =
        this.env.USER_REGISTRY.idFromName("global");

      const registry =
        this.env.USER_REGISTRY.get(id);

      const profileURL =
        new URL(
          "https://futbolx-user-registry/api/users/profile"
        );

      profileURL.searchParams.set(
        "username",
        username
      );

      const response =
        await registry.fetch(
          new Request(profileURL, {
            method: "GET"
          })
        );

      if (!response.ok) {
        return null;
      }

      const data =
        await response.json();

      return data.profile || null;

    } catch (error) {

      console.error(
        "Profile lookup error:",
        error
      );

      return null;
    }
  }


  async authenticateSocket(ws, data) {

    const username =
      String(data.username || "").trim();

    if (!username) {
      ws.send(JSON.stringify({
        type: "error",
        error: "Username required"
      }));

      return null;
    }

    const profile =
      await this.getUserProfile(username);

    if (!profile) {
      ws.send(JSON.stringify({
        type: "error",
        error: "Profile not found. Please register again."
      }));

      return null;
    }

    const attachment =
      ws.deserializeAttachment() || {};

    attachment.username =
      profile.username;

    ws.serializeAttachment(attachment);

    return profile;
  }


  /* =========================================
     WEBSOCKET MESSAGE ROUTER
  ========================================= */

  async webSocketMessage(ws, message) {

    try {

      const data =
        typeof message === "string"
          ? JSON.parse(message)
          : message;

      if (!data || typeof data !== "object") {
        return;
      }

      const attachment =
        ws.deserializeAttachment() || {};

      const eventID =
        attachment.eventID || "lobby";

      switch (data.type) {

        case "authenticate":
          await this.authenticateSocket(
            ws,
            data
          );
          break;


        case "presence_ping":

          ws.send(JSON.stringify({
            type: "presence",
            count:
              this.ctx.getWebSockets().length
          }));

          break;


        case "send_message":

          await this.handleSendMessage(
            ws,
            eventID,
            data
          );

          break;


        case "delete_message":

          await this.handleDeleteMessage(
            ws,
            eventID,
            data
          );

          break;


        case "pin_message":

          await this.handlePinMessage(
            ws,
            eventID,
            data
          );

          break;


        case "unpin_message":

          await this.handleUnpinMessage(
            ws,
            eventID
          );

          break;


        case "publish_announcement":

          await this.handleAnnouncement(
            ws,
            eventID,
            data
          );

          break;


        case "dismiss_announcement":

          await this.handleDismissAnnouncement(
            ws,
            eventID
          );

          break;


        case "save_slow_mode":

          await this.handleSlowMode(
            ws,
            eventID,
            data
          );

          break;


        case "toggle_chat_closed":

          await this.handleToggleChat(
            ws,
            eventID
          );

          break;


        case "clear_chat":

          await this.handleClearChat(
            ws,
            eventID
          );

          break;


        default:

          ws.send(JSON.stringify({
            type: "error",
            error: "Unknown message type"
          }));
      }

    } catch (error) {

      console.error(
        "WebSocket message error:",
        error
      );

      try {

        ws.send(JSON.stringify({
          type: "error",
          error: "Invalid request"
        }));

      } catch {}
    }
  }


  /* =========================================
     SEND MESSAGE
  ========================================= */

  async handleSendMessage(ws, eventID, data) {

    const attachment =
      ws.deserializeAttachment() || {};

    const username =
      attachment.username;

    if (!username) {

      ws.send(JSON.stringify({
        type: "error",
        error: "Please authenticate first"
      }));

      return;
    }

    const profile =
      await this.getUserProfile(username);

    if (!profile) {

      ws.send(JSON.stringify({
        type: "error",
        error: "Profile not found"
      }));

      return;
    }

    const text =
      String(data.message || "").trim();

    if (!text) {
      return;
    }

    if (text.length > 250) {

      ws.send(JSON.stringify({
        type: "error",
        error: "Message too long"
      }));

      return;
    }

    if (profile.is_muted) {

      ws.send(JSON.stringify({
        type: "error",
        error: "You are muted."
      }));

      return;
    }

    const settings =
      this.getRoomSettings(eventID);

    const isOwner =
      !!profile.is_owner;

    const isMod =
      !!profile.is_mod;


    if (
      settings.is_closed &&
      !isOwner &&
      !isMod
    ) {

      ws.send(JSON.stringify({
        type: "error",
        error: "Chat is currently closed"
      }));

      return;
    }


    /* Server-side slow mode */

    if (
      settings.slow_mode > 0 &&
      !isOwner &&
      !isMod
    ) {

      const last =
        this.lastMessageTimes.get(
          username.toLowerCase()
        ) || 0;

      const now =
        Date.now();

      const elapsed =
        Math.floor(
          (now - last) / 1000
        );

      if (
        elapsed < settings.slow_mode
      ) {

        const remaining =
          settings.slow_mode - elapsed;

        ws.send(JSON.stringify({
          type: "error",
          error:
            `Slow mode: wait ${remaining} seconds.`
        }));

        return;
      }

      this.lastMessageTimes.set(
        username.toLowerCase(),
        now
      );
    }


    const id =
      crypto.randomUUID();

    const createdAt =
      new Date().toISOString();


    this.sql.exec(`
      INSERT INTO messages (
        id,
        username,
        message,
        event_id,
        is_owner,
        is_mod,
        reply_to_username,
        reply_to_msg,
        reply_to_id,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      id,
      profile.username,
      text,
      eventID,
      isOwner ? 1 : 0,
      isMod ? 1 : 0,
      data.reply_to_username || null,
      data.reply_to_msg || null,
      data.reply_to_id || null,
      createdAt
    );


    const chatMessage = {
      id,
      username: profile.username,
      message: text,
      event_id: eventID,
      is_owner: isOwner,
      is_mod: isMod,
      reply_to_username:
        data.reply_to_username || null,
      reply_to_msg:
        data.reply_to_msg || null,
      reply_to_id:
        data.reply_to_id || null,
      created_at: createdAt
    };


    this.broadcast({
      type: "message_new",
      message: chatMessage
    });
  }


  /* =========================================
     DELETE MESSAGE
  ========================================= */

  async handleDeleteMessage(
    ws,
    eventID,
    data
  ) {

    const attachment =
      ws.deserializeAttachment() || {};

    const username =
      attachment.username;

    if (!username) {
      return;
    }

    const profile =
      await this.getUserProfile(username);

    if (!profile) {
      return;
    }

    const id =
      String(data.id || "").trim();

    if (!id) {
      return;
    }

    const rows =
      this.sql.exec(`
        SELECT *
        FROM messages
        WHERE id = ?
          AND event_id = ?
        LIMIT 1
      `,
        id,
        eventID
      ).toArray();

    if (!rows.length) {
      return;
    }

    const message =
      rows[0];

    const isOwner =
      !!profile.is_owner;

    const isMod =
      !!profile.is_mod;

    const isAuthor =
      message.username.toLowerCase() ===
      profile.username.toLowerCase();


    if (
      !isOwner &&
      !isMod &&
      !isAuthor
    ) {

      ws.send(JSON.stringify({
        type: "error",
        error: "Not authorized"
      }));

      return;
    }


    this.sql.exec(`
      DELETE FROM messages
      WHERE id = ?
        AND event_id = ?
    `,
      id,
      eventID
    );


    this.broadcast({
      type: "message_delete",
      id
    });


    /* If deleted message was pinned */

    const settings =
      this.getRoomSettings(eventID);

    if (
      settings.pinned_message_id === id
    ) {

      this.saveRoomSettings(
        eventID,
        {
          pinned_message_id: null
        }
      );

      this.broadcastSettings(eventID);
    }
  }


  /* =========================================
     PIN MESSAGE
  ========================================= */

  async handlePinMessage(
    ws,
    eventID,
    data
  ) {

    const profile =
      await this.authenticateSocket(
        ws,
        data
      );

    if (!profile) {
      return;
    }

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {

      ws.send(JSON.stringify({
        type: "error",
        error: "Not authorized"
      }));

      return;
    }

    const id =
      String(data.id || "").trim();

    if (!id) {
      return;
    }

    const rows =
      this.sql.exec(`
        SELECT id
        FROM messages
        WHERE id = ?
          AND event_id = ?
        LIMIT 1
      `,
        id,
        eventID
      ).toArray();

    if (!rows.length) {
      return;
    }

    this.saveRoomSettings(
      eventID,
      {
        pinned_message_id: id
      }
    );

    this.broadcastSettings(eventID);
  }


  /* =========================================
     UNPIN MESSAGE
  ========================================= */

  async handleUnpinMessage(
    ws,
    eventID
  ) {

    const attachment =
      ws.deserializeAttachment() || {};

    const profile =
      await this.getUserProfile(
        attachment.username
      );

    if (!profile) {
      return;
    }

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {
      return;
    }

    this.saveRoomSettings(
      eventID,
      {
        pinned_message_id: null
      }
    );

    this.broadcastSettings(eventID);
  }


  /* =========================================
     ANNOUNCEMENT
  ========================================= */

  async handleAnnouncement(
    ws,
    eventID,
    data
  ) {

    const attachment =
      ws.deserializeAttachment() || {};

    const profile =
      await this.getUserProfile(
        attachment.username
      );

    if (!profile || !profile.is_owner) {
      return;
    }

    const text =
      String(data.text || "").trim();

    if (text.length > 500) {
      return;
    }

    this.saveRoomSettings(
      eventID,
      {
        announcement:
          text || null
      }
    );

    this.broadcastSettings(eventID);
  }


  /* =========================================
     DISMISS ANNOUNCEMENT
  ========================================= */

  async handleDismissAnnouncement(
    ws,
    eventID
  ) {

    const attachment =
      ws.deserializeAttachment() || {};

    const profile =
      await this.getUserProfile(
        attachment.username
      );

    if (!profile || !profile.is_owner) {
      return;
    }

    this.saveRoomSettings(
      eventID,
      {
        announcement: null
      }
    );

    this.broadcastSettings(eventID);
  }


  /* =========================================
     SLOW MODE
  ========================================= */

  async handleSlowMode(
    ws,
    eventID,
    data
  ) {

    const attachment =
      ws.deserializeAttachment() || {};

    const profile =
      await this.getUserProfile(
        attachment.username
      );

    if (
      !profile ||
      (!profile.is_owner && !profile.is_mod)
    ) {
      return;
    }

    const seconds =
      Math.max(
        0,
        Math.min(
          300,
          parseInt(data.seconds, 10) || 0
        )
      );

    this.saveRoomSettings(
      eventID,
      {
        slow_mode: seconds
      }
    );

    this.broadcastSettings(eventID);
  }


  /* =========================================
     LOCK / UNLOCK CHAT
  ========================================= */

  async handleToggleChat(
    ws,
    eventID
  ) {

    const attachment =
      ws.deserializeAttachment() || {};

    const profile =
      await this.getUserProfile(
        attachment.username
      );

    if (
      !profile ||
      (!profile.is_owner && !profile.is_mod)
    ) {
      return;
    }

    const current =
      this.getRoomSettings(eventID);

    this.saveRoomSettings(
      eventID,
      {
        is_closed:
          !current.is_closed
      }
    );

    this.broadcastSettings(eventID);
  }


  /* =========================================
     CLEAR CHAT
  ========================================= */

  async handleClearChat(
    ws,
    eventID
  ) {

    const attachment =
      ws.deserializeAttachment() || {};

    const profile =
      await this.getUserProfile(
        attachment.username
      );

    if (
      !profile ||
      (!profile.is_owner && !profile.is_mod)
    ) {
      return;
    }

    this.sql.exec(`
      DELETE FROM messages
      WHERE event_id = ?
    `,
      eventID
    );

    this.broadcast({
      type: "chat_cleared"
    });

    const settings =
      this.getRoomSettings(eventID);

    if (settings.pinned_message_id) {

      this.saveRoomSettings(
        eventID,
        {
          pinned_message_id: null
        }
      );

      this.broadcastSettings(eventID);
    }
  }


  /* =========================================
     SOCKET CLOSE / ERROR
  ========================================= */

  async webSocketClose() {
    this.broadcastPresence();
  }

  async webSocketError() {
    this.broadcastPresence();
  }
                  }
