function header_filter(r) {
  delete r.headersOut["Content-Length"];
}

function body_filter(r, data, flags) {
  var proto = r.headersIn["X-Forwarded-Proto"] || "http";
  var host = r.headersIn["Host"] || "localhost";
  var baseUrl = proto + "://" + host;
  r.sendBuffer(data.replace(/{{{BASE_URL}}}/g, baseUrl), flags);
}

export default { header_filter, body_filter };
