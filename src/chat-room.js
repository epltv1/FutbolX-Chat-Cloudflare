import { DurableObject } from "cloudflare:workers";

export class FutbolXChatRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;

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

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_event_username_created
      ON messages(event_id, username, created_at)
    `);
  }

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
      String(
        url.searchParams.get("event") || "lobby"
      ).trim();

    if (!eventID) {
      return new Response(
        "Missing event ID",
        { status: 400 }
      );
    }

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
      pinned_message_id:
        row.pinned_message_id || null
    };
  }


  saveRoomSettings(eventID, changes) {

    const current =
      this.getRoomSettings(eventID);

    const next = {
      is_closed:
        changes.is_closed !== undefined
          ? !!changes.is_closed
          : current.is_closed,

      slow_mode:
        changes.slow_mode !== undefined
          ? Math.max(
              0,
              Math.min(
                300,
                Number(changes.slow_mode) || 0
              )
            )
          : current.slow_mode,

      announcement:
        changes.announcement !== undefined
          ? (
              changes.announcement === null
                ? null
                : String(changes.announcement).trim().slice(0, 500)
            )
          : current.announcement,

      pinned_message_id:
        changes.pinned_message_id !== undefined
          ? (
              changes.pinned_message_id
                ? String(changes.pinned_message_id).trim()
                : null
            )
          : current.pinned_message_id
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
      next.slow_mode,
      next.announcement,
      next.pinned_message_id
    );

    return this.getRoomSettings(eventID);
  }


  /* =========================================
     MESSAGES
  ========================================= */

  getMessages(eventID) {

    return this.sql.exec(`
      SELECT
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
      FROM messages
      WHERE event_id = ?
      ORDER BY created_at ASC
      LIMIT 100
    `, eventID).toArray().map(row => ({
      id: row.id,
      username: row.username,
      message: row.message,
      event_id: row.event_id,
      is_owner: !!row.is_owner,
      is_mod: !!row.is_mod,
      reply_to_username:
        row.reply_to_username || null,
      reply_to_msg:
        row.reply_to_msg || null,
      reply_to_id:
        row.reply_to_id || null,
      created_at: row.created_at
    }));
  }


  /* =========================================
     BROADCAST
  ========================================= */

  broadcast(payload, exclude = null) {

    const message =
      JSON.stringify(payload);

    for (
      const socket of this.ctx.getWebSockets()
    ) {

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
      count:
        this.ctx.getWebSockets().length
    });
  }


  /* =========================================
     USER REGISTRY
     
     NEVER trust browser-supplied roles.
  ========================================= */

  async getUserProfile(username) {

    const cleanUsername =
      String(username || "").trim();

    if (!cleanUsername) {
      return null;
    }

    try {

      const id =
        this.env.USER_REGISTRY.idFromName(
          "global"
        );

      const registry =
        this.env.USER_REGISTRY.get(id);

      const profileURL =
        new URL(
          "https://futbolx-user-registry/api/users/profile"
        );

      profileURL.searchParams.set(
        "username",
        cleanUsername
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

      const result =
        await response.json();

      return result.profile || null;

    } catch (error) {

      console.error(
        "User registry lookup error:",
        error
      );

      return null;
    }
  }


  /* =========================================
     SAVE USERNAME TO SOCKET
  ========================================= */

  setSocketUsername(ws, username) {

    const attachment =
      ws.deserializeAttachment() || {};

    ws.serializeAttachment({
      ...attachment,
      username
    });
  }


  /* =========================================
     WEBSOCKET MESSAGES
  ========================================= */

  async webSocketMessage(ws, message) {

    try {

      const data =
        typeof message === "string"
          ? JSON.parse(message)
          : message;

      if (
        !data ||
        typeof data !== "object"
      ) {
        return;
      }

      const attachment =
        ws.deserializeAttachment() || {};

      const eventID =
        attachment.eventID || "lobby";

      switch (data.type) {

        case "presence_ping":

          ws.send(JSON.stringify({
            type: "presence",
            count:
              this.ctx.getWebSockets().length
          }));

          break;


        case "identify":

          await this.handleIdentify(
            ws,
            eventID,
            data
          );

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
            eventID,
            data
          );

          break;


        case "set_room_settings":

          await this.handleRoomSettings(
            ws,
            eventID,
            data
          );

          break;


        case "clear_all":

          await this.handleClearAll(
            ws,
            eventID,
            data
          );

          break;


        default:

          this.sendError(
            ws,
            "Unknown message type"
          );
      }

    } catch (error) {

      console.error(
        "WebSocket message error:",
        error
      );

      this.sendError(
        ws,
        "Invalid request"
      );
    }
  }


  /* =========================================
     IDENTIFY USER
  ========================================= */

  async handleIdentify(ws, eventID, data) {

    const username =
      String(data.username || "").trim();

    if (!username) {
      this.sendError(
        ws,
        "Username required"
      );
      return;
    }

    const profile =
      await this.getUserProfile(username);

    if (!profile) {
      this.sendError(
        ws,
        "User not found"
      );
      return;
    }

    this.setSocketUsername(
      ws,
      profile.username
    );

    ws.send(JSON.stringify({
      type: "identified",
      profile: {
        username: profile.username,
        is_owner: !!profile.is_owner,
        is_mod: !!profile.is_mod,
        is_muted: !!profile.is_muted
      }
    }));
  }


  /* =========================================
     SEND MESSAGE
  ========================================= */

  async handleSendMessage(
    ws,
    eventID,
    data
  ) {

    const username =
      String(data.username || "").trim();

    const text =
      String(data.message || "").trim();

    if (!username || !text) {
      return;
    }

    if (text.length > 250) {
      this.sendError(
        ws,
        "Message too long"
      );
      return;
    }

    /*
     * Server-side profile lookup.
     * Browser role flags are ignored.
     */
    const profile =
      await this.getUserProfile(username);

    if (!profile) {
      this.sendError(
        ws,
        "User not found"
      );
      return;
    }

    this.setSocketUsername(
      ws,
      profile.username
    );

    const isOwner =
      !!profile.is_owner;

    const isMod =
      !!profile.is_mod;

    const isMuted =
      !!profile.is_muted;


    /*
     * MUTED USERS CANNOT SEND.
     */
    if (isMuted) {
      this.sendError(
        ws,
        "You are muted."
      );
      return;
    }


    const settings =
      this.getRoomSettings(eventID);


    /*
     * CLOSED CHAT.
     * Owner/mod can still speak.
     */
    if (
      settings.is_closed &&
      !isOwner &&
      !isMod
    ) {
      this.sendError(
        ws,
        "Chat is currently closed"
      );
      return;
    }


    /*
     * SERVER-SIDE SLOW MODE.
     */
    if (
      settings.slow_mode > 0 &&
      !isOwner &&
      !isMod
    ) {

      const previous =
        this.sql.exec(`
          SELECT created_at
          FROM messages
          WHERE event_id = ?
            AND lower(username) = lower(?)
          ORDER BY created_at DESC
          LIMIT 1
        `,
          eventID,
          profile.username
        ).toArray()[0];

      if (previous?.created_at) {

        const previousTime =
          new Date(
            previous.created_at
          ).getTime();

        const now =
          Date.now();

        const elapsed =
          (now - previousTime) / 1000;

        if (
          elapsed <
          settings.slow_mode
        ) {

          const remaining =
            Math.ceil(
              settings.slow_mode - elapsed
            );

          this.sendError(
            ws,
            `Slow mode: wait ${remaining}s.`
          );

          return;
        }
      }
    }


    /*
     * SERVER-SIDE AUTOMOD.
     */
    if (this.containsBlockedContent(text)) {
      this.sendError(
        ws,
        "Message blocked by moderation."
      );
      return;
    }


    /*
     * Validate reply target if supplied.
     */
    const replyToID =
      data.reply_to_id
        ? String(data.reply_to_id).trim()
        : null;

    let replyToUsername = null;
    let replyToMsg = null;

    if (replyToID) {

      const replyRows =
        this.sql.exec(`
          SELECT
            username,
            message
          FROM messages
          WHERE id = ?
            AND event_id = ?
          LIMIT 1
        `,
          replyToID,
          eventID
        ).toArray();

      if (replyRows.length) {

        replyToUsername =
          replyRows[0].username;

        replyToMsg =
          replyRows[0].message;
      }
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
      replyToUsername,
      replyToMsg,
      replyToID,
      createdAt
    );


    const newMessage = {
      id,
      username: profile.username,
      message: text,
      event_id: eventID,
      is_owner: isOwner,
      is_mod: isMod,
      reply_to_username:
        replyToUsername,
      reply_to_msg:
        replyToMsg,
      reply_to_id:
        replyToID,
      created_at: createdAt
    };


    this.broadcast({
      type: "message_new",
      message: newMessage
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
      this.sendError(
        ws,
        "Message not found"
      );
      return;
    }

    const message =
      rows[0];

    /*
     * Determine the actual requester.
     * Never trust is_owner/is_mod from browser.
     */
    const requester =
      String(data.username || "").trim();

    if (!requester) {
      this.sendError(
        ws,
        "Username required"
      );
      return;
    }

    const profile =
      await this.getUserProfile(
        requester
      );

    if (!profile) {
      this.sendError(
        ws,
        "User not found"
      );
      return;
    }

    this.setSocketUsername(
      ws,
      profile.username
    );

    const isOwner =
      !!profile.is_owner;

    const isMod =
      !!profile.is_mod;

    const ownsMessage =
      message.username.toLowerCase() ===
      profile.username.toLowerCase();


    if (
      !isOwner &&
      !isMod &&
      !ownsMessage
    ) {
      this.sendError(
        ws,
        "Not authorized"
      );
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


    /*
     * If deleted message was pinned,
     * remove the pin too.
     */
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

      this.broadcast({
        type: "room_settings",
        settings:
          this.getRoomSettings(eventID)
      });
    }


    this.broadcast({
      type: "message_delete",
      id
    });
  }


  /* =========================================
     PIN MESSAGE
  ========================================= */

  async handlePinMessage(
    ws,
    eventID,
    data
  ) {

    const username =
      String(data.username || "").trim();

    const messageID =
      String(data.id || "").trim();

    if (!username || !messageID) {
      this.sendError(
        ws,
        "Username and message ID required"
      );
      return;
    }

    const profile =
      await this.getUserProfile(username);

    if (!profile) {
      this.sendError(
        ws,
        "User not found"
      );
      return;
    }

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {
      this.sendError(
        ws,
        "Not authorized"
      );
      return;
    }

    const message =
      this.sql.exec(`
        SELECT id
        FROM messages
        WHERE id = ?
          AND event_id = ?
        LIMIT 1
      `,
        messageID,
        eventID
      ).toArray();

    if (!message.length) {
      this.sendError(
        ws,
        "Message not found"
      );
      return;
    }

    const settings =
      this.saveRoomSettings(
        eventID,
        {
          pinned_message_id:
            messageID
        }
      );

    this.broadcast({
      type: "room_settings",
      settings
    });
  }


  /* =========================================
     UNPIN MESSAGE
  ========================================= */

  async handleUnpinMessage(
    ws,
    eventID,
    data
  ) {

    const username =
      String(data.username || "").trim();

    if (!username) {
      this.sendError(
        ws,
        "Username required"
      );
      return;
    }

    const profile =
      await this.getUserProfile(username);

    if (!profile) {
      this.sendError(
        ws,
        "User not found"
      );
      return;
    }

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {
      this.sendError(
        ws,
        "Not authorized"
      );
      return;
    }

    const settings =
      this.saveRoomSettings(
        eventID,
        {
          pinned_message_id: null
        }
      );

    this.broadcast({
      type: "room_settings",
      settings
    });
  }


  /* =========================================
     ROOM SETTINGS
  ========================================= */

  async handleRoomSettings(
    ws,
    eventID,
    data
  ) {

    const username =
      String(data.username || "").trim();

    if (!username) {
      this.sendError(
        ws,
        "Username required"
      );
      return;
    }

    const profile =
      await this.getUserProfile(username);

    if (!profile) {
      this.sendError(
        ws,
        "User not found"
      );
      return;
    }

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {
      this.sendError(
        ws,
        "Not authorized"
      );
      return;
    }

    const changes = {};


    if (
      data.is_closed !== undefined
    ) {
      changes.is_closed =
        data.is_closed === true;
    }


    if (
      data.slow_mode !== undefined
    ) {
      changes.slow_mode =
        Number(data.slow_mode) || 0;
    }


    if (
      data.announcement !== undefined
    ) {

      changes.announcement =
        data.announcement === null
          ? null
          : String(
              data.announcement
            ).trim().slice(0, 500);
    }


    const settings =
      this.saveRoomSettings(
        eventID,
        changes
      );

    this.broadcast({
      type: "room_settings",
      settings
    });
  }


  /* =========================================
     CLEAR ALL MESSAGES
  ========================================= */

  async handleClearAll(
    ws,
    eventID,
    data
  ) {

    const username =
      String(data.username || "").trim();

    if (!username) {
      this.sendError(
        ws,
        "Username required"
      );
      return;
    }

    const profile =
      await this.getUserProfile(username);

    if (!profile) {
      this.sendError(
        ws,
        "User not found"
      );
      return;
    }

    /*
     * Only owner can clear the entire room.
     */
    if (!profile.is_owner) {
      this.sendError(
        ws,
        "Only the owner can clear the chat."
      );
      return;
    }

    this.sql.exec(`
      DELETE FROM messages
      WHERE event_id = ?
    `,
      eventID
    );

    this.saveRoomSettings(
      eventID,
      {
        pinned_message_id: null
      }
    );

    this.broadcast({
      type: "chat_clear"
    });

    this.broadcast({
      type: "room_settings",
      settings:
        this.getRoomSettings(eventID)
    });
  }


  /* =========================================
     BASIC SERVER-SIDE AUTOMOD
  ========================================= */

  containsBlockedContent(text) {

    const normalized =
      String(text || "")
        .toLowerCase()
        .replace(/[\s._-]+/g, "");

    const blocked = [
      "fag",
      "nigger",
      "nigga",
      "kys"
    ];

    return blocked.some(
      word =>
        normalized.includes(
          word.replace(/[\s._-]+/g, "")
        )
    );
  }


  /* =========================================
     ERROR RESPONSE
  ========================================= */

  sendError(ws, error) {

    try {

      ws.send(JSON.stringify({
        type: "error",
        error
      }));

    } catch {}
  }


  /* =========================================
     CONNECTION CLOSED
  ========================================= */

  async webSocketClose() {

    this.broadcastPresence();
  }


  /* =========================================
     WEBSOCKET ERROR
  ========================================= */

  async webSocketError() {

    this.broadcastPresence();
  }
      }
