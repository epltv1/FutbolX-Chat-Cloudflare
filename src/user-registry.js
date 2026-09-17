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

        const profile =
          this.getProfile(username);

        return this.json({
          profile
        });
      }


      /* =========================================
         REGISTER NEW USER
      ========================================= */

      if (
        request.method === "POST" &&
        url.pathname === "/api/users/register"
      ) {

        const body = await this.readJSON(request);

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
         * Futbolx is the protected owner account.
         * It can ONLY be created through the owner
         * bootstrap endpoint below.
         */
        if (
          requestedUsername.toLowerCase() === "futbolx"
        ) {
          return this.json({
            error: "That username is reserved."
          }, 403);
        }

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

        /*
         * Maximum 3 accounts per IP.
         */
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
         * Public registration can NEVER
         * create an owner or moderator.
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
          this.getProfile(requestedUsername);

        return this.json({
          success: true,
          profile
        }, 201);
      }


      /* =========================================
         BOOTSTRAP FUTBOLX OWNER
         
         This is protected by OWNER_SETUP_TOKEN.
         
         Body:
         {
           "username": "Futbolx",
           "device_ip": "...",
           "setup_token": "..."
         }
         
         This endpoint only creates the owner if
         Futbolx does not already exist.
      ========================================= */

      if (
        request.method === "POST" &&
        url.pathname === "/api/users/bootstrap-owner"
      ) {

        const body = await this.readJSON(request);

        const setupToken =
          String(body.setup_token || "").trim();

        const expectedToken =
          String(this.env.OWNER_SETUP_TOKEN || "").trim();

        if (
          !expectedToken ||
          !setupToken ||
          setupToken !== expectedToken
        ) {
          return this.json({
            error: "Unauthorized"
          }, 401);
        }

        const ownerUsername = "Futbolx";

        const existingOwner =
          this.getProfile(ownerUsername);

        if (existingOwner) {
          return this.json({
            error: "Owner account already exists",
            profile: existingOwner
          }, 409);
        }

        const deviceIP =
          String(body.device_ip || "").trim();

        this.sql.exec(`
          INSERT INTO profiles (
            username,
            device_ip,
            is_owner,
            is_mod,
            is_muted
          )
          VALUES (?, ?, 1, 0, 0)
        `,
          ownerUsername,
          deviceIP
        );

        const profile =
          this.getProfile(ownerUsername);

        return this.json({
          success: true,
          message: "Futbolx owner account created.",
          profile
        }, 201);
      }


      /* =========================================
         GET ALL MEMBERS
         
         This is used by the admin panel.
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
         
         Body:
         {
           "requester": "Futbolx",
           "username": "SomeUser",
           "is_muted": true
         }
         
         Owner or moderator may mute/unmute.
         A moderator cannot modify the owner.
      ========================================= */

      if (
        request.method === "POST" &&
        url.pathname === "/api/users/mute"
      ) {

        const body = await this.readJSON(request);

        const requester =
          String(body.requester || "").trim();

        const username =
          String(body.username || "").trim();

        const muted =
          body.is_muted === true;

        if (!requester) {
          return this.json({
            error: "Requester required"
          }, 400);
        }

        if (!username) {
          return this.json({
            error: "Username required"
          }, 400);
        }

        const requesterProfile =
          this.getProfile(requester);

        if (!requesterProfile) {
          return this.json({
            error: "Requester not found"
          }, 401);
        }

        const requesterIsOwner =
          !!requesterProfile.is_owner;

        const requesterIsMod =
          !!requesterProfile.is_mod;

        if (
          !requesterIsOwner &&
          !requesterIsMod
        ) {
          return this.json({
            error: "Not authorized"
          }, 403);
        }

        const targetProfile =
          this.getProfile(username);

        if (!targetProfile) {
          return this.json({
            error: "User not found"
          }, 404);
        }

        /*
         * Moderators cannot mute the owner.
         */
        if (
          targetProfile.is_owner &&
          !requesterIsOwner
        ) {
          return this.json({
            error: "Only the owner can modify the owner."
          }, 403);
        }

        this.sql.exec(`
          UPDATE profiles
          SET is_muted = ?
          WHERE lower(username) = lower(?)
        `,
          muted ? 1 : 0,
          username
        );

        const updatedProfile =
          this.getProfile(username);

        return this.json({
          success: true,
          profile: updatedProfile
        });
      }


      /* =========================================
         MAKE / REMOVE MOD
         
         Body:
         {
           "requester": "Futbolx",
           "username": "SomeUser",
           "is_mod": true
         }
         
         ONLY the owner can change moderator status.
      ========================================= */

      if (
        request.method === "POST" &&
        url.pathname === "/api/users/mod"
      ) {

        const body = await this.readJSON(request);

        const requester =
          String(body.requester || "").trim();

        const username =
          String(body.username || "").trim();

        const isMod =
          body.is_mod === true;

        if (!requester) {
          return this.json({
            error: "Requester required"
          }, 400);
        }

        if (!username) {
          return this.json({
            error: "Username required"
          }, 400);
        }

        const requesterProfile =
          this.getProfile(requester);

        if (!requesterProfile) {
          return this.json({
            error: "Requester not found"
          }, 401);
        }

        /*
         * ONLY owner can create/remove moderators.
         */
        if (!requesterProfile.is_owner) {
          return this.json({
            error:
              "Only the owner can change moderator status."
          }, 403);
        }

        const targetProfile =
          this.getProfile(username);

        if (!targetProfile) {
          return this.json({
            error: "User not found"
          }, 404);
        }

        /*
         * Futbolx remains owner and does not become
         * a normal moderator.
         */
        if (targetProfile.is_owner) {
          return this.json({
            error:
              "The owner account cannot be changed."
          }, 403);
        }

        this.sql.exec(`
          UPDATE profiles
          SET is_mod = ?
          WHERE lower(username) = lower(?)
        `,
          isMod ? 1 : 0,
          username
        );

        const updatedProfile =
          this.getProfile(username);

        return this.json({
          success: true,
          profile: updatedProfile
        });
      }


      /* =========================================
         INTERNAL ROLE CHECK
         
         ChatRoom will use this endpoint to verify
         a username before allowing privileged actions.
         
         Same as /profile, kept as a clear server API.
      ========================================= */

      if (
        request.method === "GET" &&
        url.pathname === "/api/users/verify"
      ) {

        const username =
          url.searchParams.get("username")?.trim();

        if (!username) {
          return this.json({
            error: "Username required"
          }, 400);
        }

        const profile =
          this.getProfile(username);

        if (!profile) {
          return this.json({
            valid: false,
            profile: null
          });
        }

        return this.json({
          valid: true,
          profile
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


  /* =========================================
     GET PROFILE
  ========================================= */

  getProfile(username) {

    const rows =
      this.sql.exec(`
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

    if (!rows.length) {
      return null;
    }

    const row = rows[0];

    return {
      username: row.username,
      device_ip: row.device_ip,
      is_owner: !!row.is_owner,
      is_mod: !!row.is_mod,
      is_muted: !!row.is_muted,
      created_at: row.created_at
    };
  }


  /* =========================================
     SAFE JSON BODY READER
  ========================================= */

  async readJSON(request) {

    try {
      return await request.json();
    } catch {
      throw new Error("Invalid JSON body");
    }
  }


  /* =========================================
     JSON RESPONSE
  ========================================= */

  json(data, status = 200) {

    return new Response(
      JSON.stringify(data),
      {
        status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization",
          "Access-Control-Allow-Methods":
            "GET, POST, PUT, DELETE, OPTIONS"
        }
      }
    );
  }
      }
