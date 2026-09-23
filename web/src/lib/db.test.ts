import { describe, expect, it, vi } from "vitest";
import { pool, withTransaction } from "@/lib/db";
import { env } from "@/lib/env";

describe("withTransaction", () => {
  it("commits successful work", async () => {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query("select 1 as value");
      return rows[0].value;
    });
    expect(result).toBe(1);
  });

  it("rolls back and rethrows on failure", async () => {
    await expect(
      withTransaction(async (client) => {
        await client.query(
          "insert into test_scratch (label) values ('rollback-check')",
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const { rows } = await pool.query(
      "select count(*)::int as count from test_scratch where label = 'rollback-check'",
    );
    expect(rows[0].count).toBe(0);
  });

  it("retries once on a serialization failure and then succeeds", async () => {
    let attempts = 0;
    const result = await withTransaction(async (client) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("simulated serialization failure") as Error & {
          code: string;
        };
        err.code = "40001";
        throw err;
      }
      const { rows } = await client.query("select 2 as value");
      return rows[0].value;
    });
    expect(attempts).toBe(2);
    expect(result).toBe(2);
  });

  it("gives up after the retry cap on repeated serialization failures", async () => {
    let attempts = 0;
    await expect(
      withTransaction(async () => {
        attempts += 1;
        const err = new Error("simulated serialization failure") as Error & {
          code: string;
        };
        err.code = "40001";
        throw err;
      }),
    ).rejects.toThrow("simulated serialization failure");
    expect(attempts).toBe(3);
  });

  it("sets the transaction's timezone to APP_TIMEZONE, scoped to that transaction only (AC-1)", async () => {
    const { rows: before } = await pool.query("select current_setting('timezone') as tz");
    const defaultTimezone = before[0].tz;

    const seenTimezone = await withTransaction(async (client) => {
      const { rows } = await client.query("select current_setting('timezone') as tz");
      return rows[0].tz;
    });
    expect(seenTimezone).toBe(env.APP_TIMEZONE);

    // Compared against the real captured default, not a placeholder — a
    // leaked setting would show env.APP_TIMEZONE here instead of reverting.
    const { rows: after } = await pool.query("select current_setting('timezone') as tz");
    expect(after[0].tz).toBe(defaultTimezone);
  });

  it("propagates the original error and releases the connection as broken if rollback itself fails (AC-1, AC-2, AC-4)", async () => {
    const realConnect = pool.connect.bind(pool);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let releaseArg: unknown = "not-called";
    const connectSpy = vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
      const client = await realConnect();
      const originalQuery = client.query.bind(client);
      const originalRelease = client.release.bind(client);
      client.query = ((text: unknown, ...rest: unknown[]) => {
        if (typeof text === "string" && text.trim().toLowerCase() === "rollback") {
          return Promise.reject(new Error("simulated broken connection"));
        }
        return (originalQuery as (...args: unknown[]) => unknown)(text, ...rest);
      }) as typeof client.query;
      client.release = ((arg?: unknown) => {
        releaseArg = arg;
        return originalRelease(arg as boolean | Error | undefined);
      }) as typeof client.release;
      return client;
    });

    await expect(
      withTransaction(async () => {
        throw new Error("original failure");
      }),
    ).rejects.toThrow("original failure");

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(releaseArg).toBeTruthy();
    connectSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
