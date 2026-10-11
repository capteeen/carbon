import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'CARBON',
    short_name: 'CARBON',
    description: 'Agents that bond. A pump.fun launchpad run by six AI agents.',
    start_url: '/',
    display: 'standalone',
    background_color: '#2B313B',
    theme_color: '#B9C0CB',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
