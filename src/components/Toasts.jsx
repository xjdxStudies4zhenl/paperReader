import React, { useEffect, useState } from 'react';
import { subscribeToast } from '../api.js';

export default function Toasts() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const unsubscribe = subscribeToast((item) => {
      setItems((prev) => {
        if (item.dismiss) return prev.filter((i) => i.id !== item.id);
        if (prev.some((i) => i.id === item.id)) return prev;
        return [...prev.slice(-4), item];
      });
    });
    return () => unsubscribe();
  }, []);

  return (
    <div className="toasts">
      {items.map((item) => (
        <div key={item.id} className={`toast ${item.type || 'info'}`}>
          {item.message}
        </div>
      ))}
    </div>
  );
}
