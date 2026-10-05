const http = require("http");
const req = http.get({ hostname: "127.0.0.1", port: process.env.PORT || 7681,
  path: "/healthz", timeout: 3000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on("timeout", () => req.destroy());
req.on("error", () => process.exit(1));
