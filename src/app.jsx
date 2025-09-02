// src/App.jsx
import React, { useEffect, useState, useRef } from "react";
import axios from "axios";
import SearchInput from "./SearchInput";

const ZAFClient = window.ZAFClient;
const PROXY = "https://intlxassetmgr-proxy.onrender.com";
const DEFAULT_API_BASE = `${PROXY}/api`;

export default function App({ client, initialRequester, initialOrg }) {
  // API base detection
  const [apiBase, setApiBase] = useState(null); // will be `${PROXY}/api` or `${PROXY}`
  const probing = useRef(false);

  // Requester + UI state
  const [requester] = useState(initialRequester || null);
  const [requesterOrg, setRequesterOrg] = useState("");
  const [assets, setAssets] = useState([]);
  const [statusOptions, setStatusOptions] = useState([]);
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [assetsError, setAssetsError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [editData, setEditData] = useState({});
  const [savedBanner, setSavedBanner] = useState(null);

  // --- Detect whether the proxy is mounted at /api or root ---
  useEffect(() => {
    if (probing.current) return;
    probing.current = true;
    (async () => {
      try {
        await axios.get(`${DEFAULT_API_BASE}/assets/schema`, { timeout: 3000 });
        setApiBase(DEFAULT_API_BASE);
      } catch {
        setApiBase(PROXY); // fallback to root
      }
    })();
  }, []);

  // Load requester org name (needs apiBase if we must fetch)
  useEffect(() => {
    if (initialOrg?.name) {
      setRequesterOrg(initialOrg.name);
      return;
    }
    if (!initialRequester?.organization_id) return;
    if (!apiBase) return; // wait for detection

    (async () => {
      try {
        const r = await axios.get(`${apiBase}/organizations/${initialRequester.organization_id}`);
        setRequesterOrg(r.data.organization?.name || "");
      } catch {
        setRequesterOrg("");
      }
    })();
  }, [initialRequester, initialOrg, apiBase]);

  // Load assets + status options
  useEffect(() => {
    // Wait until we know the correct apiBase
    if (!apiBase) return;

    if (!requester?.id) {
      setLoadingAssets(false);
      return;
    }

    (async () => {
      setLoadingAssets(true);
      setAssetsError(null);
      try {
        const res = await axios.get(`${apiBase}/assets?user_id=${requester.id}`);
        const raw = res.data.assets || [];

        // Enrich names
        const enriched = await Promise.all(
          raw.map(async (a) => {
            const f = a.custom_object_fields || {};
            let assignedName = "",
              orgName = "";
            if (f.assigned_to) {
              try {
                const rr = await axios.get(`${apiBase}/users/${f.assigned_to}`);
                assignedName = rr.data.user?.name || "";
              } catch {}
            }
            if (f.organization) {
              try {
                const or = await axios.get(`${apiBase}/organizations/${f.organization}`);
                orgName = or.data.organization?.name || "";
              } catch {}
            }
            return { ...a, assignedToName: assignedName, organizationName: orgName };
          })
        );
        setAssets(enriched);

        // Status options
        const schemaRes = await axios.get(`${apiBase}/assets/schema`);
        const statusField = schemaRes.data.fields?.find((f) => f.key === "status");
        setStatusOptions(statusField?.custom_field_options || []);
      } catch (err) {
        console.error("Assets load failed:", err);
        setAssets([]);
        const status = err?.response?.status;
        setAssetsError(
          status === 404
            ? "Asset service 404: route/params mismatch (check proxy mount path)."
            : `Failed to load assets (${status || "network"}).`
        );
      } finally {
        setLoadingAssets(false);
      }
    })();
  }, [requester, apiBase]);

  // Keep iframe sized
  useEffect(() => {
    if (!loadingAssets) client.invoke("resize");
  }, [loadingAssets, client]);

  const toggle = (asset) => {
    if (expandedId === asset.id) {
      setExpandedId(null);
    } else {
      setExpandedId(asset.id);
      setEditData((d) => ({ ...d, [asset.id]: { ...asset.custom_object_fields } }));
      setTimeout(() => client.invoke("resize"), 100);
    }
  };

  const handleChange = (id, field, value) => {
    setEditData((d) => ({ ...d, [id]: { ...d[id], [field]: value } }));
  };

  // When you select a user, also auto-fill org (if user has one)
  const handleAssignUser = async (assetId, user) => {
    handleChange(assetId, "assigned_to", user.id);

    // reflect chosen name in the visible list right away
    setAssets((prev) => prev.map((a) => (a.id === assetId ? { ...a, assignedToName: user.name } : a)));

    // try to auto-fill organization from the user
    if (user.organization_id && apiBase) {
      try {
        const r = await axios.get(`${apiBase}/organizations/${user.organization_id}`);
        const orgName = r.data.organization?.name || "";

        handleChange(assetId, "organization", String(user.organization_id));
        setAssets((prev) => prev.map((a) => (a.id === assetId ? { ...a, organizationName: orgName } : a)));
      } catch (e) {
        console.warn("Could not fetch user org:", e?.response?.status || e?.message);
      }
    }
  };

  // Save a single asset
  const saveAsset = async (id) => {
    if (!apiBase) return;
    try {
      const original = assets.find((a) => a.id === id)?.custom_object_fields || {};
      const updated = { ...original, ...editData[id] };

      const payload = {
        custom_object_fields: {
          asset_name: updated.asset_name ?? null,
          manufacturer: updated.manufacturer ?? null,
          model_number: updated.model_number ?? null,
          serial_number: updated.serial_number ?? null,
          assigned_to: updated.assigned_to ? String(updated.assigned_to) : null,
          organization: updated.organization ? String(updated.organization) : null,
          status: updated.status ?? null,
        },
      };

      const resp = await axios.patch(`${apiBase}/assets/${id}`, payload, {
        headers: { "Content-Type": "application/json" },
      });
      console.log("[SAVE] response", resp.status);

      // Refresh list after save
      const list = await axios.get(`${apiBase}/assets?user_id=${requester.id}`);
      const raw = list.data.assets || [];

      const refreshed = await Promise.all(
        raw.map(async (a) => {
          const f = a.custom_object_fields || {};
          let assignedName = "",
            orgName = "";
          if (f.assigned_to) {
            try {
              const r = await axios.get(`${apiBase}/users/${f.assigned_to}`);
              assignedName = r.data.user?.name || "";
            } catch {}
          }
          if (f.organization) {
            try {
              const r = await axios.get(`${apiBase}/organizations/${f.organization}`);
              orgName = r.data.organization?.name || "";
            } catch {}
          }
          return { ...a, assignedToName: assignedName, organizationName: orgName };
        })
      );
      setAssets(refreshed);

      // clear edits for this asset
      setEditData((d) => {
        const { [id]: _omit, ...rest } = d;
        return rest;
      });

      setSavedBanner("Saved.");
      setTimeout(() => setSavedBanner(null), 2000);
    } catch (err) {
      console.error("[SAVE] error:", err?.response?.status, err?.response?.data || err.message);
      setSavedBanner("Save failed");
      setTimeout(() => setSavedBanner(null), 2500);
    }
  };

  // Styles
  const headerStyle = { color: "#0052CC", margin: "12px 0 4px", fontSize: 18 };
  const lineStyle = { cursor: "pointer", lineHeight: 1.4, margin: "4px 0", textAlign: "left" };
  const editBox = { background: "#F4F5F7", borderRadius: 4, padding: 8, margin: "4px 0 8px 16px", fontSize: 13, lineHeight: 1.5 };
  const inputStyle = { width: "100%", margin: "0", padding: "4px", boxSizing: "border-box" };
  const btnStyle = { marginRight: 8, padding: "6px 12px", background: "#0052CC", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" };

  return (
    <div style={{ padding: 12, fontFamily: "sans-serif" }}>
      {savedBanner && (
        <div style={{ marginBottom: 8, fontSize: 12, color: savedBanner === "Saved." ? "#167d36" : "#b00020" }}>
          {savedBanner}
        </div>
      )}

      {!requester ? (
        <div>Requester not found.</div>
      ) : (
        <>
          <div style={headerStyle}>Requester</div>
          <div>
            <strong>Name:</strong> {requester.name}
          </div>
          <div>
            <strong>Email:</strong> {requester.email}
          </div>
          <div>
            <strong>ID:</strong> {requester.id}
          </div>
          {requesterOrg && (
            <div>
              <strong>Organization:</strong> {requesterOrg}
            </div>
          )}
        </>
      )}

      <div style={headerStyle}>Assigned Assets</div>

      {!apiBase ? (
        <div>Connecting to asset service…</div>
      ) : loadingAssets ? (
        <div>Loading assets…</div>
      ) : assetsError ? (
        <div style={{ color: "#b00020" }}>{assetsError}</div>
      ) : assets.length === 0 ? (
        <div>No assets assigned.</div>
      ) : (
        assets.map((a) => {
          const f = a.custom_object_fields || {};
          const ed = editData[a.id] || {};
          const status = ed.status ?? f.status ?? "Unknown";

          return (
            <div key={a.id}>
              <div style={lineStyle} onClick={() => toggle(a)}>
                <strong>{a.name}</strong> — {ed.asset_name ?? f.asset_name ?? ""} — {status}
              </div>

              {expandedId === a.id && (
                <div style={editBox}>
                  <div style={{ margin: "6px 0" }}>
                    <strong>Asset Tag:</strong> {a.name}
                  </div>

                  <div style={{ margin: "6px 0" }}>
                    <strong style={{ display: "block", marginBottom: 2 }}>Asset Name:</strong>
                    <input
                      style={inputStyle}
                      value={ed.asset_name ?? f.asset_name ?? ""}
                      onChange={(e) => handleChange(a.id, "asset_name", e.target.value)}
                    />
                  </div>

                  <div style={{ margin: "6px 0" }}>
                    <strong style={{ display: "block", marginBottom: 2 }}>Manufacturer:</strong>
                    <input
                      style={inputStyle}
                      value={ed.manufacturer ?? f.manufacturer ?? ""}
                      onChange={(e) => handleChange(a.id, "manufacturer", e.target.value)}
                    />
                  </div>

                  <div style={{ margin: "6px 0" }}>
                    <strong style={{ display: "block", marginBottom: 2 }}>Model #:</strong>
                    <input
                      style={inputStyle}
                      value={ed.model_number ?? f.model_number ?? ""}
                      onChange={(e) => handleChange(a.id, "model_number", e.target.value)}
                    />
                  </div>

                  <div style={{ margin: "6px 0" }}>
                    <strong style={{ display: "block", marginBottom: 2 }}>Serial #:</strong>
                    <input
                      style={inputStyle}
                      value={ed.serial_number ?? f.serial_number ?? ""}
                      onChange={(e) => handleChange(a.id, "serial_number", e.target.value)}
                    />
                  </div>

                  <div style={{ margin: "6px 0" }}>
                    <strong style={{ display: "block", marginBottom: 2 }}>Assigned To:</strong>
                    <SearchInput
                      key={`${a.id}-user`}
                      value={a.assignedToName}
                      onSelect={(user) => handleAssignUser(a.id, user)}
                      searchPath="users/search"
                      resultKey="users"
                      displayField="name"
                    />
                  </div>

                  <div style={{ margin: "6px 0" }}>
                    <strong style={{ display: "block", marginBottom: 2 }}>Organization:</strong>
                    <SearchInput
                      key={`${a.id}-org`}
                      value={a.organizationName}
                      onSelect={(org) => handleChange(a.id, "organization", org.id)}
                      searchPath="organizations/search"
                      resultKey="organizations"
                      displayField="name"
                    />
                  </div>

                  <div style={{ margin: "6px 0" }}>
                    <strong style={{ display: "block", marginBottom: 2 }}>Status:</strong>
                    <select
                      style={inputStyle}
                      value={ed.status ?? f.status ?? ""}
                      onChange={(e) => handleChange(a.id, "status", e.target.value)}
                    >
                      <option value="">—</option>
                      {statusOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ marginTop: 8 }}>
                    <button type="button" style={btnStyle} onClick={() => saveAsset(a.id)}>
                      Save
                    </button>
                    <button
                      type="button"
                      style={{ ...btnStyle, background: "#ABB2BF" }}
                      onClick={() => toggle(a)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
