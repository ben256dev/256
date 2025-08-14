module.exports = {
    apps: [
        {
            name: "obs_server",
            script: "obs_server.js",
            env: {
                OBS_DIR: "/home/benjamin/obs_output",
                PORT: 8000,
                FINGERPRINT_CMD: "/home/benjamin/256/obs_fingerprint.sh",
            }
        }
    ]
};

