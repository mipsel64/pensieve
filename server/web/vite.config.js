// Emit every asset as a file: the server's CSP allows fonts and images from 'self', not data: URLs.
export default { build: { assetsInlineLimit: 0 } };
