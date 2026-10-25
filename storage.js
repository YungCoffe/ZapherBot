'use strict';

const fs = require('fs');
const path = require('path');

// Defina DATA_DIR (ex.: /data num disco persistente do Render) para os dados sobreviverem a redeploys.
const DATA_DIR = process.env.DATA_DIR || '.';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* ignora */ }

const stores = new Set();

/**
 * Armazena um JSON em disco com:
 *  - cache em memória (leitura única, sem ler o disco a cada mensagem)
 *  - escrita atrasada (agrupa várias alterações numa só gravação)
 *  - escrita atômica (arquivo temporário + rename, não corrompe se o bot cair)
 *  - backup automático se o arquivo estiver corrompido
 */
class JsonStore {
  constructor(fileName, { fallback = {}, migrate = null, delay = 500 } = {}) {
    this.file = path.join(DATA_DIR, fileName);
    this.delay = delay;
    this.timer = null;
    this.dirty = false;
    this.data = this._load(fallback, migrate);
    stores.add(this);
  }

  _load(fallback, migrate) {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        if (raw.trim()) {
          const parsed = JSON.parse(raw);
          return migrate ? migrate(parsed) : parsed;
        }
      }
    } catch (err) {
      console.error(`[storage] Falha ao ler ${this.file}: ${err.message}`);
      try { fs.copyFileSync(this.file, `${this.file}.corrompido-${Date.now()}`); } catch (_) { /* ignora */ }
    }
    return fallback;
  }

  save() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delay);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.dirty = true;
      console.error(`[storage] Falha ao gravar ${this.file}: ${err.message}`);
    }
  }
}

function flushAll() {
  for (const store of stores) store.flush();
}

process.on('exit', flushAll);

module.exports = { JsonStore, flushAll, DATA_DIR };
