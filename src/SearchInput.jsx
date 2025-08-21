// src/SearchInput.jsx
import React, { useState, useEffect, useRef } from "react";
import axios from "axios";

const PROXY = "https://intlxassetmgr-proxy.onrender.com";

export default function SearchInput({ value, onSelect, onClear, searchPath, resultKey, displayField }) {
  const [search, setSearch] = useState(value || "");
  const [results, setResults] = useState([]);
  const [showResults, setShowResults] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    setSearch(value || "");
  }, [value]);

  const fetchResults = async (query) => {
    if (!query || query.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      const res = await axios.get(`${PROXY}/api/${searchPath}?q=${encodeURIComponent(query)}`);
      setResults(res.data[resultKey] || []);
    } catch {
      setResults([]);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => fetchResults(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const onDocDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        // if user cleared the text then clicked away, treat as clear
        if (!search && typeof onClear === "function") onClear();
        setShowResults(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [search, onClear]);

  return (
    <div style={{ position: "relative" }} ref={containerRef}>
      <input
        type="text"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setShowResults(true);
          // live-clear if emptied without waiting for blur
          if (e.target.value === "" && typeof onClear === "function") onClear();
        }}
        style={{ width: "100%", padding: 4, border: "1px solid #ccc", borderRadius: 4 }}
      />
      {showResults && results.length > 0 && (
        <ul
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            background: "#fff",
            border: "1px solid #ccc",
            borderRadius: 4,
            maxHeight: 150,
            overflowY: "auto",
            zIndex: 1000,
            listStyle: "none",
            margin: 0,
            padding: 0
          }}
        >
          {results.map((item) => (
            <li
              key={item.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item);
                setSearch(item[displayField] || "");
                setShowResults(false);
              }}
              style={{ padding: "4px 8px", cursor: "pointer", borderBottom: "1px solid #eee" }}
            >
              {item[displayField]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
