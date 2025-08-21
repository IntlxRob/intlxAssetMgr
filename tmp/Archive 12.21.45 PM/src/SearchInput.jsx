// src/SearchInput.jsx
import React, { useState, useEffect } from 'react';
import axios from 'axios';

const PROXY = "https://intlxassetmgr-proxy.onrender.com";

export default function SearchInput({ value, onSelect, searchPath, resultKey, displayField }) {
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState([]);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setQuery(value || '');
  }, [value]);

  useEffect(() => {
    if (query === value || query.length < 2) {
      setResults([]);
      setIsOpen(false);
      return;
    }
    const delayDebounceFn = setTimeout(() => {
      axios.get(`${PROXY}/api/${searchPath}`, { params: { query } })
        .then(response => {
          setResults(response.data[resultKey] || []);
          setIsOpen(true);
        })
        .catch(error => {
          console.error('Search failed:', error);
          setResults([]);
        });
    }, 300);
    return () => clearTimeout(delayDebounceFn);
  }, [query, searchPath, resultKey, value]);

  const handleSelect = (item) => {
    setQuery(item[displayField]);
    onSelect(item);
    setIsOpen(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => setTimeout(() => setIsOpen(false), 200)}
        style={{ width: '100%', margin: '0', padding: '4px', boxSizing: 'border-box' }}
      />
      {isOpen && results.length > 0 && (
        <ul style={{
          position: 'absolute',
          background: 'white',
          border: '1px solid #ccc',
          width: '100%',
          listStyle: 'none',
          padding: 0,
          margin: 0,
          marginTop: '2px',
          maxHeight: 150,
          overflowY: 'auto',
          zIndex: 10
        }}>
          {results.map((item) => (
            <li
              key={item.id}
              onMouseDown={() => handleSelect(item)}
              style={{ padding: '8px', cursor: 'pointer', borderBottom: '1px solid #eee' }}
            >
              {item[displayField]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}