// src/http-init.js
import axios from "axios";

// (optional) keep your current absolute URLs; do NOT set baseURL to avoid surprises
// axios.defaults.baseURL = "https://intlxassetmgr-proxy.onrender.com/api";
axios.defaults.timeout = 20000;

function uuid() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11)
    .replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}

// Request logging + correlation id
axios.interceptors.request.use((config) => {
  config.headers = config.headers || {};
  if (!config.headers["x-correlation-id"]) {
    config.headers["x-correlation-id"] = uuid();
  }
  console.debug("[HTTP ➜]", config.method?.toUpperCase(), config.url, {
    headers: config.headers,
    params: config.params,
    data: config.data,
  });
  return config;
});

// Response logging (and surfacing server error bodies)
axios.interceptors.response.use(
  (res) => {
    console.debug("[HTTP ⬅]", res.config?.url, res.status, res.data);
    return res;
  },
  (err) => {
    const res = err.response;
    console.error("[HTTP ⬅ ERROR]", {
      url: res?.config?.url,
      status: res?.status,
      data: res?.data,
      headers: res?.headers,
    });
    return Promise.reject(err);
  }
);
