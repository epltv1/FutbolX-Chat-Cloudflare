import { DurableObject } from "cloudflare:workers";

export class FutbolXUserRegistry extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        username TEXT PRIMARY KEY,
        device_ip TEXT,
        is_owner INTEGER NOT NULL DEFAULT 0,
        is_mod INTEGER NOT NULL DEFAULT 0,
        is_muted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_profiles_ip
      ON profiles(device_ip)
    `);
  }

  async fetch(request) {

    const url = new URL(request.url);

    try {

      /* =========================================
         GET ONE PROFILE
      ========================================= */

      if (
        request.method === "GET" &&
        url.pathname === "/api/users/profile"
      ) {

        const username =
          url.searchParams.get("username")?.trim();

        if (!username) {
          return this.json({
            error: "Username required"
          }, 400);
        }

        const rows = this.sql.exec(`
          SELECT
            username,
            device_ip,
            is_owner,
            is_mod,
            is_muted,
            created_at
          FROM profiles
          WHERE lower(username) = lower(?)
          LIMIT 1
        `, username).toArray();

        return this.json({
          profile: rows[0] || null
        });
      }


      /* =========================================
         REGISTER USER
      ========================================= */

      if (
        request.method === "POST" &&
        url.pathname === "/api/users/register"
      ) {

        const body = await request.json();

        const requestedUsername =
          String(body.username || "").trim();

        const deviceIP =
          String(body.device_ip || "").trim();

        if (!requestedUsername) {
          return this.json({
            error: "Username required"
          }, 400);
        }

        if (requestedUsername.length < 2) {
          return this.json({
            error: "Username is too short"
          }, 400);
        }

        if (requestedUsername.length > 20) {
          return this.json({
            error: "Username is too long"
          }, 400);
        }

        if (!/^[a-zA-Z0-9_]+$/.test(requestedUsername)) {
          return this.json({
            error:
              "Username can only contain letters, numbers and underscores"
          }, 400);
        }

        /*
         * Futbolx is reserved.
         * Nobody can register it through the public endpoint.
         */
        if (
          requestedUsername.toLowerCase() === "futbolx"
        ) {
          return this.json({
            error: "That username is reserved."
          }, 403);
        }

        /* Check username */

        const existingUser =
          this.sql.exec(`
            SELECT username
            FROM profiles
            WHERE lower(username) = lower(?)
            LIMIT 1
          `, requestedUsername).toArray();

        if (existingUser.length) {
          return this.json({
            error: "Username taken"
          }, 409);
        }

        /* Maximum 3 accounts per IP */

        if (deviceIP) {

          const result =
            this.sql.exec(`
              SELECT COUNT(*) AS count
              FROM profiles
              WHERE device_ip = ?
            `, deviceIP).one();

          const count =
            Number(result?.count || 0);

          if (count >= 3) {
            return this.json({
              error:
                "Limit reached: 3 accounts per IP."
            }, 429);
          }
        }

        /*
         * IMPORTANT:
         * Public registration NEVER creates an owner/mod.
         */
        this.sql.exec(`
          INSERT INTO profiles (
            username,
            device_ip,
            is_owner,
            is_mod,
            is_muted
          )
          VALUES (?, ?, 0, 0, 0)
        `,
          requestedUsername,
          deviceIP
        );

        const profile =
          this.sql.exec(`
            SELECT
              username,
              device_ip,
              is_owner,
              is_mod,
              is_muted,
              created_at
            FROM profiles
            WHERE username = ?
            LIMIT 1
          `, requestedUsername).toArray()[0];

        return this.json({
          success: true,
          profile
        }, 201);
      }


      /* =========================================
         GET ALL MEMBERS
      ========================================= */

      if (
        request.method === "GET" &&
        url.pathname === "/api/users/members"
      ) {

        const members =
          this.sql.exec(`
            SELECT
              username,
              device_ip,
              is_owner,
              is_mod,
              is_muted,
              created_at
            FROM profiles
            ORDER BY created_at ASC
          `).toArray();

        return this.json({
          members
        });
      }


      /* =========================================
         MUTE / UNMUTE USER
      ========================================= */

      if (
        request.method === "POST" &&
        url.pathname === "/api/users/mute"
      ) {

        const body = await request.json();

        const username =
          String(body.username || "").trim();

        const muted =
          body.is_muted === true;

        if (!username) {
          return this.json({
            error: "Username required"
          }, 400);
        }

        const result =
          this.sql.exec(`
            UPDATE profiles
            SET is_muted = ?
            WHERE lower(username) = lower(?)
          `,
            muted ? 1 : 0,
            username
          );

        if (result.rowsWritten === 0) {
          return this.json({
            error: "User not found"
          }, 404);
        }

        return this.json({
          success: true,
          username,
          is_muted: muted
        });
      }


      /* =========================================
         MAKE / REMOVE MOD
      ========================================= */

      if (
        request.method === "POST" &&
        url.pathname === "/api/users/mod"
      ) {

        const body = await request.json();

        const username =
          String(body.username || "").trim();

        const isMod =
          body.is_mod === true;

        if (!username) {
          return this.json({
            error: "Username required"
          }, 400);
        }

        const result =
          this.sql.exec(`
            UPDATE profiles
            SET is_mod = ?
            WHERE lower(username) = lower(?)
          `,
            isMod ? 1 : 0,
            username
          );

        if (result.rowsWritten === 0) {
          return this.json({
            error: "User not found"
          }, 404);
        }

        return this.json({
          success: true,
          username,
          is_mod: isMod
        });
      }


      /* =========================================
         UNKNOWN ENDPOINT
      ========================================= */

      return this.json({
        error: "Unknown user endpoint"
      }, 404);

    } catch (error) {

      console.error(
        "User registry error:",
        error
      );

      return this.json({
        error: "Internal server error"
      }, 500);
    }
  }


  json(data, status = 200) {

    return new Response(
      JSON.stringify(data),
      {
        status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
        }
      }
    );
  }
        }
