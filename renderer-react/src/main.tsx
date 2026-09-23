import React from 'react';
import ReactDOM from 'react-dom/client';
import AdminNav from '@/components/admin-nav';
import './index.css';

function mount() {
  const container = document.getElementById('admin-nav-root');
  if (container) {
    const root = ReactDOM.createRoot(container);
    root.render(
      <React.StrictMode>
        <AdminNav />
      </React.StrictMode>
    );
  }
}

// Mount when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
