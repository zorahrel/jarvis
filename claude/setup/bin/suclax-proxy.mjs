// Compatibilità per le finestre già aperte su :3348: il routing vive in VDM.
import http from "node:http";
const server = http.createServer((request, response) => {
  if (request.url === "/health") { response.writeHead(200); response.end("{}"); return; }
  const upstream = http.request({hostname:"127.0.0.1",port:3336,path:request.url,
    method:request.method,headers:request.headers}, result => {
    response.writeHead(result.statusCode, result.headers);
    result.pipe(response);
  });
  upstream.on("error", () => {
    response.writeHead(502,{"content-type":"application/json"});
    response.end('{"type":"error","error":{"type":"proxy_error","message":"VDM unavailable"}}');
  });
  request.pipe(upstream);
});
server.listen(3348,"127.0.0.1");
