import { DurableObject } from "cloudflare:workers";

export class FutbolXChatRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;

    /*
     * Restore hibernating WebSocket connections.
     */
    this.ctx.getWebSockets().forEach((ws) => {
      try {
        ws.deserializeAttachment();
      } catch (error) {
        console.error("WebSocket attachment restore error:", error);
      }
    });

    /*
     * Database tables
     */
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_settings (
        event_id TEXT PRIMARY KEY,
        is_closed INTEGER NOT NULL DEFAULT 0,
        slow_mode INTEGER NOT NULL DEFAULT 0,
        announcement TEXT,
        pinned_message_id INTEGER
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        message TEXT NOT NULL,
        event_id TEXT NOT NULL,
        is_owner INTEGER NOT NULL DEFAULT 0,
        is_mod INTEGER NOT NULL DEFAULT 0,
        reply_to_username TEXT,
        reply_to_msg TEXT,
        reply_to_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_event
      ON messages(event_id, id)
    `);
  }

  /*
   * ============================================================
   * WEBSOCKET CONNECTION
   * ============================================================
   */

  async fetch(request) {

    const url = new URL(request.url);

    const eventID =
      url.searchParams.get("event")?.trim();

    if (!eventID) {
      return new Response(
        "Missing event ID",
        { status: 400 }
      );
    }

    if (request.method !== "GET") {
      return new Response(
        "GET required",
        { status: 405 }
      );
    }

    const upgrade =
      request.headers.get("Upgrade");

    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response(
        "WebSocket upgrade required",
        { status: 426 }
      );
    }

    /*
     * Create WebSocket pair.
     */
    const pair = new WebSocketPair();

    const client = pair[0];
    const server = pair[1];

    /*
     * IMPORTANT:
     *
     * Accept the server socket using the Durable Object
     * Hibernation WebSocket API.
     */
    this.ctx.acceptWebSocket(server);

    /*
     * Store connection state.
     *
     * This survives Durable Object hibernation.
     */
    server.serializeAttachment({
      eventID,
      username: null,
      authenticated: false,
      lastMessageAt: 0
    });

    /*
     * Return the WebSocket upgrade IMMEDIATELY.
     *
     * Do not perform database queries before returning 101.
     */
    const response = new Response(null, {
      status: 101,
      webSocket: client
    });

    /*
     * Initialize the room after the upgrade has been accepted.
     */
    this.initializeSocket(server, eventID).catch((error) => {

      console.error(
        "Socket initialization error:",
        error
      );

      try {
        server.close(
          1011,
          "Room initialization failed"
        );
      } catch {}
    });

    return response;
  }

  async initializeSocket(ws, eventID) {

    /*
     * Make sure room exists.
     */
    this.ensureRoom(eventID);

    /*
     * Send initial room data.
     */
    const settings =
      this.getSettings(eventID);

    const messages =
      this.getMessages(eventID);

    this.send(ws, {
      type: "room_init",
      event_id: eventID,
      settings,
      messages,
      viewers: this.viewerCount()
    });

    /*
     * Send current presence.
     */
    this.broadcast({
      type: "presence",
      viewers: this.viewerCount()
    });
  }

  /*
   * ============================================================
   * ROOM DATABASE
   * ============================================================
   */

  ensureRoom(eventID) {

    const existing =
      this.sql.exec(`
        SELECT event_id
        FROM room_settings
        WHERE event_id = ?
        LIMIT 1
      `, eventID).toArray();

    if (!existing.length) {

      this.sql.exec(`
        INSERT INTO room_settings (
          event_id,
          is_closed,
          slow_mode,
          announcement,
          pinned_message_id
        )
        VALUES (?, 0, 0, NULL, NULL)
      `, eventID);
    }
  }

  getSettings(eventID) {

    this.ensureRoom(eventID);

    return this.sql.exec(`
      SELECT
        event_id,
        is_closed,
        slow_mode,
        announcement,
        pinned_message_id
      FROM room_settings
      WHERE event_id = ?
      LIMIT 1
    `, eventID).toArray()[0];
  }

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
      ORDER BY id DESC
      LIMIT 100
    `, eventID)
      .toArray()
      .reverse();
  }

  /*
   * ============================================================
   * WEBSOCKET HELPERS
   * ============================================================
   */

  viewerCount() {

    return this.ctx
      .getWebSockets()
      .length;
  }

  send(ws, data) {

    try {

      if (
        !ws ||
        ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      ws.send(
        JSON.stringify(data)
      );

    } catch (error) {

      console.error(
        "WebSocket send error:",
        error
      );
    }
  }

  broadcast(data, except = null) {

    const payload =
      JSON.stringify(data);

    for (
      const ws of this.ctx.getWebSockets()
    ) {

      if (ws === except) {
        continue;
      }

      try {

        if (
          ws.readyState === WebSocket.OPEN
        ) {
          ws.send(payload);
        }

      } catch (error) {

        console.error(
          "Broadcast error:",
          error
        );
      }
    }
  }

  /*
   * ============================================================
   * PROFILE
   * ============================================================
   */

  async getProfile(username) {

    if (!username) {
      return null;
    }

    try {

      const id =
        this.env.USER_REGISTRY
          .idFromName("global");

      const registry =
        this.env.USER_REGISTRY.get(id);

      const response =
        await registry.fetch(
          new Request(
            "https://futbolx-user-registry" +
            "/api/users/profile?username=" +
            encodeURIComponent(username)
          )
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

  /*
   * ============================================================
   * AUTHENTICATION
   * ============================================================
   */

  async authenticateSocket(ws, data) {

    const username =
      String(
        data.username || ""
      ).trim();

    if (!username) {

      this.send(ws, {
        type: "error",
        error: "Username required."
      });

      return null;
    }

    const profile =
      await this.getProfile(username);

    if (!profile) {

      this.send(ws, {
        type: "error",
        error: "Profile not found."
      });

      return null;
    }

    const attachment =
      ws.deserializeAttachment() || {};

    const updated = {
      ...attachment,
      username: profile.username,
      authenticated: true
    };

    ws.serializeAttachment(updated);

    this.send(ws, {
      type: "authenticated",
      profile
    });

    this.broadcast({
      type: "presence",
      viewers: this.viewerCount()
    });

    return profile;
  }

  /*
   * ============================================================
   * WEBSOCKET MESSAGE HANDLER
   * ============================================================
   */

  async webSocketMessage(ws, message) {

    try {

      let data;

      if (typeof message === "string") {

        data = JSON.parse(message);

      } else if (
        message instanceof ArrayBuffer
      ) {

        const text =
          new TextDecoder()
            .decode(message);

        data = JSON.parse(text);

      } else {

        this.send(ws, {
          type: "error",
          error: "Invalid WebSocket message."
        });

        return;
      }

      if (
        !data ||
        typeof data !== "object"
      ) {
        return;
      }

      /*
       * AUTHENTICATE
       */
      if (
        data.type === "authenticate"
      ) {

        await this.authenticateSocket(
          ws,
          data
        );

        return;
      }

      /*
       * Get connection state.
       */
      const attachment =
        ws.deserializeAttachment() || {};

      if (!attachment.authenticated) {

        this.send(ws, {
          type: "error",
          error: "Please authenticate first."
        });

        return;
      }

      const username =
        attachment.username;

      const profile =
        await this.getProfile(username);

      if (!profile) {

        this.send(ws, {
          type: "error",
          error: "Profile no longer exists."
        });

        return;
      }

      /*
       * SEND MESSAGE
       */
      if (
        data.type === "send_message"
      ) {

        await this.handleSendMessage(
          ws,
          profile,
          data
        );

        return;
      }

      /*
       * DELETE MESSAGE
       */
      if (
        data.type === "delete_message"
      ) {

        await this.handleDeleteMessage(
          ws,
          profile,
          data
        );

        return;
      }

      /*
       * PIN
       */
      if (
        data.type === "pin_message"
      ) {

        await this.handlePinMessage(
          ws,
          profile,
          data
        );

        return;
      }

      /*
       * UNPIN
       */
      if (
        data.type === "unpin_message"
      ) {

        await this.handleUnpinMessage(
          ws,
          profile
        );

        return;
      }

      /*
       * ANNOUNCEMENT
       */
      if (
        data.type === "set_announcement"
      ) {

        await this.handleAnnouncement(
          ws,
          profile,
          data
        );

        return;
      }

      /*
       * SLOW MODE
       */
      if (
        data.type === "set_slow_mode"
      ) {

        await this.handleSlowMode(
          ws,
          profile,
          data
        );

        return;
      }

      /*
       * CHAT LOCK
       */
      if (
        data.type === "toggle_chat_lock"
      ) {

        await this.handleChatLock(
          ws,
          profile,
          data
        );

        return;
      }

      /*
       * CLEAR ROOM
       */
      if (
        data.type === "clear_room"
      ) {

        await this.handleClearRoom(
          ws,
          profile
        );

        return;
      }

      /*
       * TYPING
       */
      if (
        data.type === "typing"
      ) {

        this.broadcast({
          type: "typing",
          username: profile.username,
          is_typing:
            data.is_typing === true
        }, ws);

        return;
      }

    } catch (error) {

      console.error(
        "WebSocket message error:",
        error
      );

      this.send(ws, {
        type: "error",
        error:
          "Server error while processing your request."
      });
    }
  }

  /*
   * ============================================================
   * SEND MESSAGE
   * ============================================================
   */

  async handleSendMessage(
    ws,
    profile,
    data
  ) {

    const eventID =
      this.getEventID(ws);

    const settings =
      this.getSettings(eventID);

    if (settings?.is_closed) {

      this.send(ws, {
        type: "error",
        error:
          "Chat is currently closed."
      });

      return;
    }

    if (profile.is_muted) {

      this.send(ws, {
        type: "error",
        error:
          "You are muted."
      });

      return;
    }

    const message =
      String(
        data.message || ""
      ).trim();

    if (!message) {
      return;
    }

    if (message.length > 500) {

      this.send(ws, {
        type: "error",
        error:
          "Message is too long."
      });

      return;
    }

    const now =
      Date.now();

    const attachment =
      ws.deserializeAttachment() || {};

    /*
     * Slow mode
     */
    if (
      settings?.slow_mode &&
      !profile.is_owner &&
      !profile.is_mod &&
      attachment.lastMessageAt &&
      now -
        attachment.lastMessageAt <
        5000
    ) {

      this.send(ws, {
        type: "error",
        error:
          "Slow mode is enabled. Please wait."
      });

      return;
    }

    const replyToUsername =
      data.reply_to_username
        ? String(data.reply_to_username)
        : null;

    const replyToMsg =
      data.reply_to_msg
        ? String(data.reply_to_msg)
        : null;

    const replyToID =
      data.reply_to_id
        ? Number(data.reply_to_id)
        : null;

    this.sql.exec(`
      INSERT INTO messages (
        username,
        message,
        event_id,
        is_owner,
        is_mod,
        reply_to_username,
        reply_to_msg,
        reply_to_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      profile.username,
      message,
      eventID,
      profile.is_owner ? 1 : 0,
      profile.is_mod ? 1 : 0,
      replyToUsername,
      replyToMsg,
      replyToID
    );

    const saved =
      this.sql.exec(`
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
        WHERE id = last_insert_rowid()
        LIMIT 1
      `)
      .toArray()[0];

    ws.serializeAttachment({
      ...attachment,
      lastMessageAt: now
    });

    this.broadcast({
      type: "message_new",
      message: saved
    });
  }

  /*
   * ============================================================
   * DELETE
   * ============================================================
   */

  async handleDeleteMessage(
    ws,
    profile,
    data
  ) {

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {

      this.send(ws, {
        type: "error",
        error:
          "Permission denied."
      });

      return;
    }

    const id =
      Number(data.id);

    if (!id) {
      return;
    }

    this.sql.exec(`
      DELETE FROM messages
      WHERE id = ?
    `, id);

    this.broadcast({
      type: "message_deleted",
      id
    });
  }

  /*
   * ============================================================
   * PIN
   * ============================================================
   */

  async handlePinMessage(
    ws,
    profile,
    data
  ) {

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {

      this.send(ws, {
        type: "error",
        error:
          "Permission denied."
      });

      return;
    }

    const id =
      Number(data.id);

    if (!id) {
      return;
    }

    const eventID =
      this.getEventID(ws);

    this.sql.exec(`
      UPDATE room_settings
      SET pinned_message_id = ?
      WHERE event_id = ?
    `, id, eventID);

    this.broadcast({
      type: "pinned",
      id
    });
  }

  /*
   * ============================================================
   * UNPIN
   * ============================================================
   */

  async handleUnpinMessage(
    ws,
    profile
  ) {

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {

      this.send(ws, {
        type: "error",
        error:
          "Permission denied."
      });

      return;
    }

    const eventID =
      this.getEventID(ws);

    this.sql.exec(`
      UPDATE room_settings
      SET pinned_message_id = NULL
      WHERE event_id = ?
    `, eventID);

    this.broadcast({
      type: "unpinned"
    });
  }

  /*
   * ============================================================
   * ANNOUNCEMENT
   * ============================================================
   */

  async handleAnnouncement(
    ws,
    profile,
    data
  ) {

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {

      this.send(ws, {
        type: "error",
        error:
          "Permission denied."
      });

      return;
    }

    const announcement =
      String(
        data.announcement || ""
      ).trim();

    const eventID =
      this.getEventID(ws);

    this.sql.exec(`
      UPDATE room_settings
      SET announcement = ?
      WHERE event_id = ?
    `,
      announcement || null,
      eventID
    );

    this.broadcast({
      type: "announcement",
      announcement:
        announcement || null
    });
  }

  /*
   * ============================================================
   * SLOW MODE
   * ============================================================
   */

  async handleSlowMode(
    ws,
    profile,
    data
  ) {

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {

      this.send(ws, {
        type: "error",
        error:
          "Permission denied."
      });

      return;
    }

    const enabled =
      data.enabled === true;

    const eventID =
      this.getEventID(ws);

    this.sql.exec(`
      UPDATE room_settings
      SET slow_mode = ?
      WHERE event_id = ?
    `,
      enabled ? 1 : 0,
      eventID
    );

    this.broadcast({
      type: "slow_mode",
      enabled
    });
  }

  /*
   * ============================================================
   * CHAT LOCK
   * ============================================================
   */

  async handleChatLock(
    ws,
    profile,
    data
  ) {

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {

      this.send(ws, {
        type: "error",
        error:
          "Permission denied."
      });

      return;
    }

    const closed =
      data.closed === true;

    const eventID =
      this.getEventID(ws);

    this.sql.exec(`
      UPDATE room_settings
      SET is_closed = ?
      WHERE event_id = ?
    `,
      closed ? 1 : 0,
      eventID
    );

    this.broadcast({
      type: "chat_lock",
      closed
    });
  }

  /*
   * ============================================================
   * CLEAR ROOM
   * ============================================================
   */

  async handleClearRoom(
    ws,
    profile
  ) {

    if (
      !profile.is_owner &&
      !profile.is_mod
    ) {

      this.send(ws, {
        type: "error",
        error:
          "Permission denied."
      });

      return;
    }

    const eventID =
      this.getEventID(ws);

    this.sql.exec(`
      DELETE FROM messages
      WHERE event_id = ?
    `, eventID);

    this.sql.exec(`
      UPDATE room_settings
      SET pinned_message_id = NULL
      WHERE event_id = ?
    `, eventID);

    this.broadcast({
      type: "room_cleared"
    });
  }

  /*
   * ============================================================
   * EVENT ID
   * ============================================================
   */

  getEventID(ws) {

    const attachment =
      ws.deserializeAttachment() || {};

    return (
      attachment.eventID ||
      "unknown"
    );
  }

  /*
   * ============================================================
   * CLOSE
   * ============================================================
   */

  webSocketClose(
    ws,
    code,
    reason,
    wasClean
  ) {

    console.log(
      "Chat WebSocket closed:",
      code,
      reason,
      wasClean
    );

    this.broadcast({
      type: "presence",
      viewers: this.viewerCount()
    });
  }

  /*
   * ============================================================
   * ERROR
   * ============================================================
   */

  webSocketError(
    ws,
    error
  ) {

    console.error(
      "Chat WebSocket error:",
      error
    );
  }
}
