// Storage for the relay, behind one interface so the routes can be tested without D1.
//
// Every method is a single logical operation. If a method needs two statements they both live
// in the D1 adapter, not in the route, so the memory adapter cannot quietly behave differently.

export function createMemoryStore() {
  const devices = new Map();
  const pairCodes = new Map();
  const phones = new Map();
  const attempts = new Map();

  return {
    async getDevice(id) {
      return devices.get(id) ? { ...devices.get(id) } : null;
    },
    async putDevice(device) {
      devices.set(device.id, { ...device });
    },
    async touchDevice(id, at) {
      const device = devices.get(id);
      if (device) device.lastSeenAt = at;
    },

    async deletePairCodesForDevice(deviceId) {
      for (const [id, row] of pairCodes) if (row.deviceId === deviceId) pairCodes.delete(id);
    },
    async putPairCode(row) {
      pairCodes.set(row.id, { ...row });
    },
    async getPairCodeByHash(codeHash) {
      for (const row of pairCodes.values()) if (row.codeHash === codeHash) return { ...row };
      return null;
    },
    async bumpPairCodeAttempts(id) {
      const row = pairCodes.get(id);
      if (row) row.attempts += 1;
    },
    async deletePairCode(id) {
      pairCodes.delete(id);
    },

    async putPhone(phone) {
      phones.set(phone.id, { ...phone });
    },
    async getPhone(id) {
      return phones.get(id) ? { ...phones.get(id) } : null;
    },
    async revokePhone(id, at) {
      const phone = phones.get(id);
      if (phone) phone.revokedAt = at;
    },
    async listPhones(deviceId) {
      return [...phones.values()].filter((phone) => phone.deviceId === deviceId).map((phone) => ({ ...phone }));
    },

    async countClaims(address, since) {
      let total = 0;
      for (const [key, value] of attempts) {
        const [storedAddress, windowStart] = key.split('|');
        if (storedAddress === address && Number(windowStart) >= since) total += value;
      }
      return total;
    },
    async recordClaim(address, windowStart) {
      const key = `${address}|${windowStart}`;
      attempts.set(key, (attempts.get(key) || 0) + 1);
    },
  };
}

// D1 adapter. Statements are bound, never interpolated, and the schema is relay/schema.sql.
export function createD1Store(db) {
  const first = async (sql, ...params) => {
    const row = await db.prepare(sql).bind(...params).first();
    return row || null;
  };
  const run = async (sql, ...params) => {
    await db.prepare(sql).bind(...params).run();
  };

  return {
    async getDevice(id) {
      return first('SELECT id, key_hash AS keyHash, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE id = ?', id);
    },
    async putDevice(device) {
      await run(
        'INSERT INTO devices (id, key_hash, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        device.id, device.keyHash, device.name, device.createdAt, device.lastSeenAt,
      );
    },
    async touchDevice(id, at) {
      await run('UPDATE devices SET last_seen_at = ? WHERE id = ?', at, id);
    },

    async deletePairCodesForDevice(deviceId) {
      await run('DELETE FROM pair_codes WHERE device_id = ?', deviceId);
    },
    async putPairCode(row) {
      await run(
        'INSERT INTO pair_codes (id, device_id, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        row.id, row.deviceId, row.codeHash, row.attempts, row.expiresAt, row.createdAt,
      );
    },
    async getPairCodeByHash(codeHash) {
      return first(
        'SELECT id, device_id AS deviceId, code_hash AS codeHash, attempts, expires_at AS expiresAt FROM pair_codes WHERE code_hash = ? ORDER BY created_at DESC LIMIT 1',
        codeHash,
      );
    },
    async bumpPairCodeAttempts(id) {
      await run('UPDATE pair_codes SET attempts = attempts + 1 WHERE id = ?', id);
    },
    async deletePairCode(id) {
      await run('DELETE FROM pair_codes WHERE id = ?', id);
    },

    async putPhone(phone) {
      await run(
        'INSERT INTO phones (id, device_id, name, token_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        phone.id, phone.deviceId, phone.name, phone.tokenHash, phone.createdAt, phone.lastSeenAt,
      );
    },
    async getPhone(id) {
      return first(
        'SELECT id, device_id AS deviceId, name, token_hash AS tokenHash, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM phones WHERE id = ?',
        id,
      );
    },
    async revokePhone(id, at) {
      await run('UPDATE phones SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', at, id);
    },
    async listPhones(deviceId) {
      const result = await db.prepare(
        'SELECT id, device_id AS deviceId, name, created_at AS createdAt, revoked_at AS revokedAt FROM phones WHERE device_id = ?',
      ).bind(deviceId).all();
      return result?.results || [];
    },

    async countClaims(address, since) {
      const row = await first('SELECT SUM(count) AS total FROM claim_attempts WHERE address = ? AND window_start >= ?', address, since);
      return Number(row?.total || 0);
    },
    async recordClaim(address, windowStart) {
      await run(
        'INSERT INTO claim_attempts (address, window_start, count) VALUES (?, ?, 1) ON CONFLICT(address, window_start) DO UPDATE SET count = count + 1',
        address, windowStart,
      );
    },
  };
}
