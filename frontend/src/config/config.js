// Configuration for the frontend application
// Uses environment variable instead of hard-coded backend URL

const config = {
  // Backend base URL (set via environment variable)
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || `http://${window.location.hostname}:5000`,

  // Get the full API URL for a given endpoint
  getApiUrl: (endpoint) => {
    const base = config.apiBaseUrl;
    const cleanBase = base.replace(/\/api$/, "");
    return `${cleanBase}${endpoint}`;
  },
};

export default config;
