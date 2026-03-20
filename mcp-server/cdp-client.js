import http from 'node:http';

export class CdpClient {
  constructor(port, token) {
    this.port = port;
    this.token = token;
  }

  async listPanels() {
    return this._get('/cdp/panels');
  }

  async sendCommand(webContentsId, method, params = {}) {
    return this._post('/cdp/command', { webContentsId, method, params });
  }

  async detach(webContentsId) {
    return this._post('/cdp/detach', { webContentsId });
  }

  async openPanel(url, termId, profileId, groupId) {
    return this._post('/open-panel', { url, termId, profileId, groupId });
  }

  _get(path) {
    return new Promise((resolve, reject) => {
      const url = `http://127.0.0.1:${this.port}${path}?token=${this.token}`;
      http.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      }).on('error', reject);
    });
  }

  _post(path, body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port: this.port,
        path: `${path}?token=${this.token}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}
