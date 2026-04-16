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

  async getNetworkRequests(webContentsId) {
    return this._post('/cdp/network-requests', { webContentsId });
  }

  async clearNetworkRequests(webContentsId) {
    return this._post('/cdp/network-clear', { webContentsId });
  }

  async getConsoleMessages(webContentsId) {
    return this._post('/cdp/console-messages', { webContentsId });
  }

  async clearConsoleMessages(webContentsId) {
    return this._post('/cdp/console-clear', { webContentsId });
  }

  async addRoute(webContentsId, route) {
    return this._post('/cdp/route-add', { webContentsId, route });
  }

  async removeRoute(webContentsId, pattern) {
    return this._post('/cdp/route-remove', { webContentsId, pattern });
  }

  async listRoutes(webContentsId) {
    return this._post('/cdp/route-list', { webContentsId });
  }

  _get(path) {
    return new Promise((resolve, reject) => {
      const url = `http://127.0.0.1:${this.port}${path}?token=${this.token}`;
      http.get(url, (res) => {
        const statusCode = res.statusCode;
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (statusCode >= 400) {
              reject(new Error(parsed.error || `HTTP ${statusCode}: ${data}`));
            } else {
              resolve(parsed);
            }
          } catch {
            if (statusCode >= 400) {
              reject(new Error(`HTTP ${statusCode}: ${data}`));
            } else {
              resolve(data);
            }
          }
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
        const statusCode = res.statusCode;
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (statusCode >= 400) {
              reject(new Error(parsed.error || `HTTP ${statusCode}: ${data}`));
            } else {
              resolve(parsed);
            }
          } catch {
            if (statusCode >= 400) {
              reject(new Error(`HTTP ${statusCode}: ${data}`));
            } else {
              resolve(data);
            }
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}
