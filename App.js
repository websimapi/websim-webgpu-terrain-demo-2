import React from 'react';
import { createRoot } from 'react-dom/client';
import WebGPUTerrainDemo from './WebGPUTerrainDemo.js';

const root = createRoot(document.getElementById('root'));
root.render(React.createElement(WebGPUTerrainDemo));

