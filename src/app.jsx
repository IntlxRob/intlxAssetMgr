import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

const BACKEND_BASE_URL = "https://intlxassetmgr-proxy.onrender.com";

function App() {
  const [assets, setAssets] = useState([]);
  const [requester, setRequester] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [formData, setFormData] = useState({});
  const [users, setUsers] = useState([]);
  const [organizations, setOrganizations] = useState([]);
  const [newAssetRequest, setNewAssetRequest] = useState([]);

  useEffect(() => {
    if (!window.ZAFClient) {
      console.warn("ZAFClient not available");
      return;
    }

    const client = window.ZAFClient.init();
    client.invoke("resize");

    async function load() {
      try {
        const ticketData = await client.get("ticket.requester");
        setRequester(ticketData["ticket.requester"]);

        const userId = ticketData["ticket.requester"]?.id;
        if (userId) {
          fetch(`${BACKEND_BASE_URL}/api/user-assets?user_id=${userId}`)
            .then((res) => res.json())
            .then((data) => setAssets(data.assets || []))
            .finally(() => setLoading(false));
        }

        fetch(`${BACKEND_BASE_URL}/api/users`)
          .then((res) => res.json())
          .then((data) => setUsers(data.users || []))
          .catch(() => setUsers([]));

        fetch(`${BACKEND_BASE_URL}/api/organizations`)
          .then((res) => res.json())
          .then((data) => setOrganizations(data.organizations || []))
          .catch(() => setOrganizations([]));
      } catch (err) {
        console.error("Error loading data:", err);
      }
    }

    load();
  }, []);

  function handleAssetClick(asset) {
    setSelectedAsset(asset);
    setFormData({
      ...asset.custom_object_fields,
      assigned_to_user: asset.custom_object_fields?.assigned_to || '',
      assigned_to_org: asset.custom_object_fields?.organization || ''
    });
  }

  function handleInputChange(e) {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSave() {
    if (!selectedAsset) return;
    try {
      let payload = { ...formData };

      if (formData.assigned_to_user) {
        payload.assigned_to = formData.assigned_to_user;
        delete payload.assigned_to_org;
      } else if (formData.assigned_to_org) {
        payload.assigned_to = formData.assigned_to_org;
        delete payload.assigned_to_user;
      } else {
        delete payload.assigned_to_user;
        delete payload.assigned_to_org;
      }

      delete payload.assigned_to_user;
      delete payload.assigned_to_org;

      const res = await fetch(`${BACKEND_BASE_URL}/api/assets/${selectedAsset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to update asset");
      const updatedAsset = await res.json();
      setAssets((prevAssets) =>
        prevAssets.map((a) => (a.id === updatedAsset.id ? updatedAsset : a))
      );
      alert("Asset updated successfully!");
      setSelectedAsset(null);
    } catch (err) {
      alert("Error updating asset: " + err.message);
    }
  }

  async function handleSubmitNewRequest() {
    try {
      if (!newAssetRequest.length || !requester) return;
      const payload = {
        subject: "New Asset Catalog Request",
        description: "Catalog request submission",
        name: requester.name,
        email: requester.email,
        approved_by: requester.name,
        assets: newAssetRequest,
      };
      const res = await fetch(`${BACKEND_BASE_URL}/api/ticket`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Request failed: " + res.status);
      alert("Request submitted!");
      setNewAssetRequest([]);
    } catch (err) {
      alert("Submission failed: " + err.message);
    }
  }

  function handleBack() {
    setSelectedAsset(null);
  }

  if (loading) return <div>Loading assets...</div>;

  return (
    <div style={{ fontFamily: "sans-serif", padding: 8 }}>
      <h2>Asset Manager (React)</h2>
      <div><b>Requester:</b> {requester ? requester.name : "Unknown"}</div>

      {!selectedAsset && (
        <ul style={{ marginTop: 10 }}>
          {assets.map((a) => (
            <li
              key={a.id || a.name}
              onClick={() => handleAssetClick(a)}
              style={{
                cursor: "pointer",
                padding: "4px",
                borderRadius: "4px",
                marginBottom: "2px",
                border: "1px solid #ccc",
              }}
            >
              {`${a.name || "No Tag"} - ${a.custom_object_fields?.asset_name || "Unnamed Asset"}`}
            </li>
          ))}
        </ul>
      )}

      {selectedAsset && (
        <div style={{ marginTop: 20 }}>
          <button onClick={handleBack} style={{ marginBottom: 10 }}>
            ← Back to Asset List
          </button>
          <h3>Edit Asset Details</h3>

          <label>Asset Tag: <b>{selectedAsset.name || "No Tag"}</b></label><br />

          <label>
            Asset Name: <input name="asset_name" value={formData.asset_name || ""} onChange={handleInputChange} />
          </label><br />

          <label>
            Serial Number: <input name="serial_number" value={formData.serial_number || ""} onChange={handleInputChange} />
          </label><br />

          <label>
            Status:
            <select name="status" value={formData.status || ""} onChange={handleInputChange}>
              <option value="">-- Select Status --</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="retired">Retired</option>
            </select>
          </label><br />

          <label>
            Assigned To User:
            <select name="assigned_to_user" value={formData.assigned_to_user || ""} onChange={handleInputChange}>
              <option value="">-- Select User --</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>{user.name}</option>
              ))}
            </select>
          </label><br />

          <label>
            Organization:
            <select name="assigned_to_org" value={formData.assigned_to_org || ""} onChange={handleInputChange}>
              <option value="">-- Select Organization --</option>
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </select>
          </label><br />

          <button onClick={handleSave} style={{ marginTop: 10 }}>Save</button>
        </div>
      )}

      <div style={{ marginTop: 30 }}>
        <h3>Catalog Request (Submit)</h3>
        <button onClick={() => setNewAssetRequest([{ Name: "Example Asset", Manufacturer: "Dell", "Model Number": "XPS 15" }])}>
          + Request New Asset
        </button>
        {newAssetRequest.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <ul>
              {newAssetRequest.map((item, idx) => (
                <li key={idx}><b>{item.Name}</b> - {item.Manufacturer} / {item["Model Number"]}</li>
              ))}
            </ul>
            <button onClick={handleSubmitNewRequest}>Submit Request</button>
          </div>
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);

export default App;
