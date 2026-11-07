export function isAllowedRendererRequest(requestUrl, serverUrl) {
  try {
    const request = new URL(requestUrl);
    const server = new URL(serverUrl);
    return (request.protocol === 'http:' || request.protocol === 'ws:')
      && request.hostname === server.hostname
      && request.port === server.port;
  } catch {
    return false;
  }
}
