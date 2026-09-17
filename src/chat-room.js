import { DurableObject } from "cloudflare:workers";

export class FutbolXChatRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {

    console.log("CHAT ROOM FETCH START");

    const upgrade =
      request.headers.get("Upgrade");

    console.log("Upgrade header:", upgrade);

    if (
      request.method !== "GET" ||
      upgrade?.toLowerCase() !== "websocket"
    ) {
      return new Response(
        JSON.stringify({
          error: "WebSocket upgrade required",
          method: request.method,
          upgrade
        }),
        {
          status: 426,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    try {

      const pair = new WebSocketPair();

      const client = pair[0];
      const server = pair[1];

      console.log("WebSocketPair created");

      this.ctx.acceptWebSocket(server);

      console.log("WebSocket accepted");

      server.serializeAttachment({
        test: true
      });

      console.log("Attachment saved");

      return new Response(null, {
        status: 101,
        webSocket: client
      });

    } catch (error) {

      console.error(
        "WEBSOCKET ACCEPT ERROR:",
        error
      );

      return new Response(
        JSON.stringify({
          error: "WebSocket server error",
          message: error?.message || String(error)
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }
  }

  webSocketMessage(ws, message) {

    console.log(
      "WEBSOCKET MESSAGE:",
      message
    );

    try {

      ws.send(
        JSON.stringify({
          type: "test",
          message: String(message)
        })
      );

    } catch (error) {

      console.error(
        "WEBSOCKET SEND ERROR:",
        error
      );
    }
  }

  webSocketClose(
    ws,
    code,
    reason,
    wasClean
  ) {

    console.log(
      "WEBSOCKET CLOSED:",
      code,
      reason,
      wasClean
    );
  }

  webSocketError(
    ws,
    error
  ) {

    console.error(
      "WEBSOCKET ERROR:",
      error
    );
  }
}
