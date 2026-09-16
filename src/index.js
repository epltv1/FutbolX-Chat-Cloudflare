import { FutbolXChatRoom } from "./chat-room.js";
import { FutbolXUserRegistry } from "./user-registry.js";

export { FutbolXChatRoom, FutbolXUserRegistry };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // Health check
    if (url.pathname === "/") {
      return json({
        ok: true,
        service: "FutbolX Chat",
        status: "online"
      });
    }

    // Chat WebSocket
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/ws/chat/")
    ) {
      const eventID = decodeURIComponent(
        url.pathname.substring("/ws/chat/".length)
      ).trim();

      if (!eventID) {
        return json({ error: "Missing event ID" }, 400);
      }

      if (
        request.headers.get("Upgrade")?.toLowerCase() !==
        "websocket"
      ) {
        return json({
          error: "WebSocket upgrade required"
        }, 426);
      }

      const id = env.CHAT_ROOMS.idFromName(
        `event:${eventID}`
      );

      const room = env.CHAT_ROOMS.get(id);

      const roomURL =
        new URL("https://futbolx-chat-room/ws");

      roomURL.searchParams.set("event", eventID);

      return room.fetch(
        new Request(roomURL, request)
      );
    }

    // User API
    if (url.pathname.startsWith("/api/users/")) {
      const id = env.USER_REGISTRY.idFromName("global");

      const registry = env.USER_REGISTRY.get(id);

      const registryURL =
        new URL(
          "https://futbolx-user-registry" +
          url.pathname
        );

      registryURL.search = url.search;

      return registry.fetch(
        new Request(registryURL, request)
      );
    }

    return json({
      error: "Not found"
    }, 404);
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",
    "Access-Control-Allow-Methods":
      "GET, POST, PUT, DELETE, OPTIONS"
  };
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...corsHeaders()
      }
    }
  );
        }
