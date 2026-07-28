import pg from 'pg';

const { Pool } = pg;

class NeonQueryBuilder {
  constructor(pool, tableName) {
    this.pool = pool;
    this.tableName = tableName;
    this.operation = 'SELECT';
    this.selectCols = '*';
    this.isHead = false;
    this.isCount = false;
    this.insertData = null;
    this.updateData = null;
    this.upsertData = null;
    this.whereConditions = [];
    this.whereValues = [];
    this.orderBy = [];
    this.limitVal = null;
    this.offsetVal = null;
    this.isSingle = false;
    this.isMaybeSingle = false;
    this.onConflictCols = null;
  }

  select(cols = '*', opts = {}) {
    if (this.operation === 'INSERT' || this.operation === 'UPSERT') {
      return this;
    }
    this.operation = 'SELECT';
    this.selectCols = cols || '*';
    if (opts.head) this.isHead = true;
    if (opts.count) this.isCount = true;
    return this;
  }

  insert(data) {
    this.operation = 'INSERT';
    this.insertData = Array.isArray(data) ? data : [data];
    return this;
  }

  upsert(data, opts = {}) {
    this.operation = 'UPSERT';
    this.upsertData = Array.isArray(data) ? data : [data];
    if (opts.onConflict) this.onConflictCols = opts.onConflict;
    return this;
  }

  update(data) {
    this.operation = 'UPDATE';
    this.updateData = data;
    return this;
  }

  delete() {
    this.operation = 'DELETE';
    return this;
  }

  _addCond(col, op, val) {
    this.whereValues.push(val);
    const paramIdx = this.whereValues.length;
    this.whereConditions.push(`"${col}" ${op} $${paramIdx}`);
    return this;
  }

  eq(col, val) { return this._addCond(col, '=', val); }
  neq(col, val) { return this._addCond(col, '!=', val); }
  gt(col, val) { return this._addCond(col, '>', val); }
  gte(col, val) { return this._addCond(col, '>=', val); }
  lt(col, val) { return this._addCond(col, '<', val); }
  lte(col, val) { return this._addCond(col, '<=', val); }
  like(col, pattern) { return this._addCond(col, 'LIKE', pattern); }
  ilike(col, pattern) { return this._addCond(col, 'ILIKE', pattern); }

  // Supabase .is(col, null) => "col" IS NULL
  is(col, val) {
    if (val === null) {
      this.whereConditions.push(`"${col}" IS NULL`);
    } else {
      this.whereConditions.push(`"${col}" IS ${val}`);
    }
    return this;
  }

  // Supabase .not(col, operator, value) => NOT ("col" op value)
  not(col, op, val) {
    if (op === 'is' && val === null) {
      this.whereConditions.push(`"${col}" IS NOT NULL`);
    } else if (op === 'in') {
      // .not('col', 'in', '(a,b,c)')
      const items = String(val).replace(/^\(|\)$/g, '').split(',').map(s => s.trim());
      const params = [];
      for (const item of items) {
        this.whereValues.push(item);
        params.push(`$${this.whereValues.length}`);
      }
      this.whereConditions.push(`"${col}" NOT IN (${params.join(', ')})`);
    } else if (op === 'eq') {
      this.whereValues.push(val);
      this.whereConditions.push(`"${col}" != $${this.whereValues.length}`);
    } else if (op === 'like' || op === 'LIKE') {
      this.whereValues.push(val);
      this.whereConditions.push(`"${col}" NOT LIKE $${this.whereValues.length}`);
    } else if (op === 'ilike' || op === 'ILIKE') {
      this.whereValues.push(val);
      this.whereConditions.push(`"${col}" NOT ILIKE $${this.whereValues.length}`);
    } else {
      // generic fallback
      this.whereValues.push(val);
      this.whereConditions.push(`NOT ("${col}" ${op} $${this.whereValues.length})`);
    }
    return this;
  }

  in(col, arr) {
    if (!arr || !arr.length) {
      this.whereConditions.push('1 = 0');
      return this;
    }
    const params = [];
    for (const item of arr) {
      this.whereValues.push(item);
      params.push(`$${this.whereValues.length}`);
    }
    this.whereConditions.push(`"${col}" IN (${params.join(', ')})`);
    return this;
  }

  order(col, opts = {}) {
    const dir = opts.ascending === false ? 'DESC' : 'ASC';
    const nulls = opts.nullsFirst ? ' NULLS FIRST' : (opts.nullsLast ? ' NULLS LAST' : '');
    this.orderBy.push(`"${col}" ${dir}${nulls}`);
    return this;
  }

  limit(n) {
    this.limitVal = n;
    return this;
  }

  range(from, to) {
    this.offsetVal = from;
    this.limitVal = (to - from) + 1;
    return this;
  }

  single() {
    this.isSingle = true;
    this.limitVal = 1;
    return this;
  }

  maybeSingle() {
    this.isMaybeSingle = true;
    this.limitVal = 1;
    return this;
  }

  async then(resolve, reject) {
    try {
      const res = await this._execute();
      resolve(res);
    } catch (err) {
      if (reject) reject(err);
      else resolve({ data: null, error: err, count: null });
    }
  }

  async _execute() {
    try {
      const whereClause = this.whereConditions.length ? `WHERE ${this.whereConditions.join(' AND ')}` : '';
      const orderClause = this.orderBy.length ? `ORDER BY ${this.orderBy.join(', ')}` : '';
      const limitClause = this.limitVal !== null ? `LIMIT ${this.limitVal}` : '';
      const offsetClause = this.offsetVal !== null ? `OFFSET ${this.offsetVal}` : '';

      if (this.operation === 'SELECT') {
        if (this.isHead && this.isCount) {
          const sql = `SELECT COUNT(*) FROM "${this.tableName}" ${whereClause};`;
          const { rows } = await this.pool.query(sql, this.whereValues);
          const count = parseInt(rows[0]?.count || '0', 10);
          return { data: null, count, error: null };
        }

        const cols = this.selectCols === '*' ? '*' : this.selectCols.split(',').map(c => `"${c.trim()}"`).join(', ');
        let sql = `SELECT ${cols} FROM "${this.tableName}" ${whereClause} ${orderClause} ${limitClause} ${offsetClause};`;

        const { rows } = await this.pool.query(sql, this.whereValues);

        if (this.isCount) {
          const countSql = `SELECT COUNT(*) FROM "${this.tableName}" ${whereClause};`;
          const countRes = await this.pool.query(countSql, this.whereValues);
          const count = parseInt(countRes.rows[0]?.count || '0', 10);
          return { data: rows, count, error: null };
        }

        if (this.tableName === 'notifications') {
          rows.forEach(r => {
            if (r && r.body !== undefined && r.message === undefined) {
              r.message = r.body;
            }
          });
        }

        if (this.isSingle) {
          if (!rows.length) return { data: null, error: { message: 'Row not found' }, count: null };
          return { data: rows[0], error: null, count: null };
        }
        if (this.isMaybeSingle) {
          return { data: rows.length ? rows[0] : null, error: null, count: null };
        }

        return { data: rows, error: null, count: null };
      }

      if (this.operation === 'INSERT') {
        const rowsToInsert = this.insertData || [];
        if (!rowsToInsert.length) return { data: [], error: null };
        if (this.tableName === 'notifications') {
          rowsToInsert.forEach(r => {
            if (r && r.message !== undefined && r.body === undefined) {
              r.body = r.message;
              delete r.message;
            }
          });
        }

        const allCols = [...new Set(rowsToInsert.flatMap(r => Object.keys(r)))];
        const colNames = allCols.map(c => `"${c}"`).join(', ');
        
        const valueTuples = [];
        const params = [];

        rowsToInsert.forEach(row => {
          const tupleParams = [];
          allCols.forEach(c => {
            params.push(row[c] !== undefined ? row[c] : null);
            tupleParams.push(`$${params.length}`);
          });
          valueTuples.push(`(${tupleParams.join(', ')})`);
        });

        const formatParam = (v) => typeof v === 'object' && v !== null ? JSON.stringify(v) : v;

        const sql = `INSERT INTO "${this.tableName}" (${colNames}) VALUES ${valueTuples.join(', ')} RETURNING *;`;
        try {
          const { rows } = await this.pool.query(sql, params.map(formatParam));
          if (this.isSingle) return { data: rows[0] || null, error: null };
          return { data: rows, error: null };
        } catch (insertErr) {
          // Unique constraint violations (23505) → return as Supabase-style error
          if (insertErr.code === '23505') {
            return { data: null, error: { message: insertErr.message, code: insertErr.code, details: insertErr.detail } };
          }
          throw insertErr;
        }
      }

      if (this.operation === 'UPSERT') {
        const rowsToInsert = this.upsertData || [];
        if (!rowsToInsert.length) return { data: [], error: null };
        if (this.tableName === 'notifications') {
          rowsToInsert.forEach(r => {
            if (r && r.message !== undefined && r.body === undefined) {
              r.body = r.message;
              delete r.message;
            }
          });
        }

        const allCols = [...new Set(rowsToInsert.flatMap(r => Object.keys(r)))];
        const colNames = allCols.map(c => `"${c}"`).join(', ');
        
        const valueTuples = [];
        const params = [];

        rowsToInsert.forEach(row => {
          const tupleParams = [];
          allCols.forEach(c => {
            params.push(row[c] !== undefined ? row[c] : null);
            tupleParams.push(`$${params.length}`);
          });
          valueTuples.push(`(${tupleParams.join(', ')})`);
        });

        const updateSet = allCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
        // Handle comma-separated conflict columns: 'user_id, signal_id' → ("user_id", "signal_id")
        let conflictClause = '';
        if (this.onConflictCols) {
          const cols = this.onConflictCols.split(',').map(c => `"${c.trim()}"`);
          conflictClause = `(${cols.join(', ')})`;
        }

        const formatParam = (v) => typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
        const sql = `INSERT INTO "${this.tableName}" (${colNames}) VALUES ${valueTuples.join(', ')} ON CONFLICT ${conflictClause} DO UPDATE SET ${updateSet} RETURNING *;`;
        const { rows } = await this.pool.query(sql, params.map(formatParam));

        if (this.isSingle) return { data: rows[0] || null, error: null };
        return { data: rows, error: null };
      }

      if (this.operation === 'UPDATE') {
        const keys = Object.keys(this.updateData || {});
        if (!keys.length) return { data: [], error: null };

        const formatParam = (v) => typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
        const setClauses = [];
        const params = [...this.whereValues];

        keys.forEach(k => {
          let val = this.updateData[k];
          params.push(formatParam(val ?? null));
          setClauses.push(`"${k}" = $${params.length}`);
        });

        const sql = `UPDATE "${this.tableName}" SET ${setClauses.join(', ')} ${whereClause} RETURNING *;`;
        const { rows } = await this.pool.query(sql, params);

        if (this.isSingle) return { data: rows[0] || null, error: null };
        return { data: rows, error: null };
      }

      if (this.operation === 'DELETE') {
        const sql = `DELETE FROM "${this.tableName}" ${whereClause} RETURNING *;`;
        const { rows } = await this.pool.query(sql, this.whereValues);
        return { data: rows, error: null };
      }

      return { data: null, error: new Error('Unsupported operation') };
    } catch (err) {
      return { data: null, error: { message: err.message }, count: null };
    }
  }
}

export function createNeonClient(connectionString, realSupabaseClient = null) {
  const pool = new Pool({
    connectionString,
    max: 30,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: false },
  });

  return {
    pool,
    from(tableName) {
      return new NeonQueryBuilder(pool, tableName);
    },
    async rpc(fnName, params = {}) {
      try {
        const keys = Object.keys(params);
        const args = keys.map((_, i) => `$${i + 1}`).join(', ');
        const values = keys.map(k => params[k]);
        const sql = `SELECT * FROM ${fnName}(${args});`;
        const { rows } = await pool.query(sql, values);
        const data = rows[0]?.[fnName] !== undefined ? rows[0][fnName] : rows;
        return { data, error: null };
      } catch (err) {
        return { data: null, error: { message: err.message } };
      }
    },
    // Pass through auth to real Supabase client for Google Auth / JWT verification
    auth: realSupabaseClient ? realSupabaseClient.auth : {
      async getUser(token) {
        if (realSupabaseClient) return realSupabaseClient.auth.getUser(token);
        return { data: { user: null }, error: { message: 'Auth not configured' } };
      }
    }
  };
}
