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
      connectedAt: Date.now()
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

  getMessages(eventID) {

    return this.sql.exec(`
      SELECT *
      FROM messages
      WHERE event_id = ?
      ORDER BY created_at ASC
      LIMIT 100
    `, eventID).toArray();
  }

  broadcast(payload, exclude = null) {

    const message = JSON.stringify(payload);

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

        case "presence_ping":
          ws.send(JSON.stringify({
            type: "presence",
            count: this.ctx.getWebSockets().length
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

  async handleSendMessage(ws, eventID, data) {

    const username =
      String(data.username || "").trim();

    const text =
      String(data.message || "").trim();

    if (!username || !text) {
      return;
    }

    if (text.length > 250) {
      ws.send(JSON.stringify({
        type: "error",
        error: "Message too long"
      }));
      return;
    }

    const settings =
      this.getRoomSettings(eventID);

    const isOwner =
      data.is_owner === true;

    const isMod =
      data.is_mod === true;

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
      username,
      text,
      eventID,
      isOwner ? 1 : 0,
      isMod ? 1 : 0,
      data.reply_to_username || null,
      data.reply_to_msg || null,
      data.reply_to_id || null,
      createdAt
    );

    const message = {
      id,
      username,
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
      message
    });
  }

  async handleDeleteMessage(ws, eventID, data) {

    const id =
      String(data.id || "").trim();

    if (!id) {
      return;
    }

    const rows = this.sql.exec(`
      SELECT *
      FROM messages
      WHERE id = ?
        AND event_id = ?
      LIMIT 1
    `, id, eventID).toArray();

    if (!rows.length) {
      return;
    }

    const message = rows[0];

    const username =
      String(data.username || "").trim();

    const isOwner =
      data.is_owner === true;

    const isMod =
      data.is_mod === true;

    if (
      !isOwner &&
      !isMod &&
      message.username !== username
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
    `, id, eventID);

    this.broadcast({
      type: "message_delete",
      id
    });
  }

  async webSocketClose() {
    this.broadcastPresence();
  }

  async webSocketError() {
    this.broadcastPresence();
  }
        }
