module.exports = {
  apps: [
    {
      name: "fpl-trends-api",
      script: "dist/server.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--max-old-space-size=384",
      max_memory_restart: "512M",
      env: { NODE_ENV: "production" },
      kill_timeout: 10000,
      exp_backoff_restart_delay: 1000,
    },
    {
      name: "fpl-trends-analytics",
      script: "dist/analytics/worker.js",
      instances: 1,
      exec_mode: "fork",
      node_args: "--max-old-space-size=1792",
      max_memory_restart: "2100M",
      env: { NODE_ENV: "production" },
      kill_timeout: 180000,
      exp_backoff_restart_delay: 1000,
    },
  ],
};
