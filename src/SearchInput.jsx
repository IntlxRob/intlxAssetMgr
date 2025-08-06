import React, { useState, useEffect } from 'react';
import axios from 'axios';

const PROXY = 'https://intlxassetmgr-proxy.onrender.com';

export default function SearchInput({ value, onSelect, searchPath, resultKey, displayField }) {
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    if (!query || query.length < 2) return;

    const timeout = setTimeout(async () => {
      try {
        const res = await axios.get(`${PROXY}/api/${searchPath}?q=${encodeURIComponent(query)}`);
        setResults(res.data?.[resultKey] || []);
      } catch (err) {
        console.error('Search failed:', err);
        setResults([]);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [query, searchPath, resultKey]);

  const handleSelect = (item) => {
    onSelect(item);
    setQuery(item[displayField]);
    setShowDropdown(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        style={{ width: '100%', padding: 4, border: '1px solid #ccc', borderRadius: 4 }}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => setShowDropdown(true)}
        onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
      />
      {showDropdown && results.length > 0 && (
        <ul style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          background: '#fff',
          border: '1px solid #ccc',
          maxHeight: 150,
          overflowY: 'auto',
          zIndex: 1000,
          margin: 0,
          padding: 0,
          listStyle: 'none'
        }}>
          {results.map(item => (
            <li
              key={item.id}
              style={{ padding: 6, cursor: 'pointer' }}
              onMouseDown={() => handleSelect(item)}
            >
              {item[displayField]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
