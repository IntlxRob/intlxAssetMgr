import React from "react";

export const Card = ({ children, className = "" }) => (
  <div className={`border rounded p-4 shadow-sm ${className}`}>{children}</div>
);

export const CardContent = ({ children }) => (
  <div className="mt-2">{children}</div>
);
