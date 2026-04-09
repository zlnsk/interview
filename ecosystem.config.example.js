module.exports = {
  apps: [{
    name: 'Interview',
    script: 'server.js',
    env: {
      PORT: 3014,
      DEEPGRAM_API_KEY: 'your_deepgram_api_key',
      OPENROUTER_API_KEY: 'your_openrouter_api_key',
    },
  }],
};
