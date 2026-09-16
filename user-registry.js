import { DurableObject } from "cloudflare:workers";

export class FutbolXUserRegistry extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

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

      /* Get one profile */
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
          WHERE username = ?
          LIMIT 1
        `, username).toArray();

        return this.json({
          profile: rows[0] || null
        });
      }

      /* Register user */
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

        const cleanName =
          requestedUsername.toLowerCase() === "futbolx"
            ? "Futbolx"
            : requestedUsername;

        /* Check username */
        const existingUser =
          this.sql.exec(`
            SELECT username
            FROM profiles
            WHERE lower(username) = lower(?)
            LIMIT 1
          `, cleanName).toArray();

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
          cleanName,
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
          `, cleanName).toArray()[0];

        return this.json({
          success: true,
          profile
        }, 201);
      }

      /* Get all members */
      if (
        request.method === "GET" &&
        url.pathname === "/api/users/members"
      ) {

        const members
