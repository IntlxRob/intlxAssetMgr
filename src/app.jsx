import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom";

const BACKEND_BASE_URL = "https://intlxassetmgr-proxy.onrender.com";

function App() {
  const [assets, setAssets] = useState([]);
  const [requester, setRequester] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ZAFClient = window.ZAFClient;
    const client = ZAFClient.init();

    async function load() {
      const ticketData = await client.get("ticket.requester");
      setRequester(ticketData["ticket.requester"]);
      const userId = ticketData["ticket.requester"]?.id;
      if (userId) {
        fetch(`${BACKEND_BASE_URL}/api/user-assets?user_id=${userId}`)
          .then((res) => res.json())
          .then((data) => setAssets(data.assets || []))
          .finally(() => setLoading(false));
      }
    }
    load();
  }, []);

  return (
    <div style={{ fontFamily: "sans-serif", padding: 8 }}>
      <h2>Asset Manager (React)</h2>
      {loading ? (
        <p>Loading assets...</p>
      ) : (
        <>
          <div>
            <b>Requester:</b> {requester ? requester.name : "Unknown"}
          </div>
          <ul>
            {assets.map((a) => (
              <li key={a.id || a.name}>
                <b>{a.custom_object_fields?.asset_name}</b>
                {a.custom_object_fields?.serial_number &&
                  ` — Serial: ${a.custom_object_fields.serial_number}`}
                {a.custom_object_fields?.status &&
                  ` — Status: ${a.custom_object_fields.status}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// Render React to the sidebar
ReactDOM.render(<App />, document.getElementById("root"));
