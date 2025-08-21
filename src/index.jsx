// src/index.jsx

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import "./http-init";

const ZAFClient = window.ZAFClient;

// Find the root HTML element in your index.html
const container = document.getElementById('root');
const root = ReactDOM.createRoot(container);

// 1. Initialize the ZAF Client. It returns the client object directly.
const client = ZAFClient.init();

// 2. Use the client object to get the initial data.
//    client.get() returns a Promise, which we can use .then() on.
Promise.all([
  client.get("ticket.requester"),
  client.get("ticket.organization")
]).then(data => {
  const requester = data[0]["ticket.requester"];
  const organization = data[1]["ticket.organization"];

  // 3. Render the App component and pass the initial data as props.
  root.render(
    <React.StrictMode>
      <App client={client} initialRequester={requester} initialOrg={organization} />
    </React.StrictMode>
  );

  // 4. After the initial render, resize the frame.
  client.invoke("resize");

}).catch(error => {
  console.error("Failed to get initial data from ZAF client", error);
  // Render an error message if the data fetch fails
  root.render(<div>Error loading initial data.</div>);
});