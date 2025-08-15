module.exports = {
    apps: [
        {
            name: "obs_server",
            script: "obs_server.js",
            exec_mode: "fork",
            instances: 1,
            watch: false,
            env: {
                OBS_DIR: "/home/benjamin/obs_output",
                PORT: 8000,
                HOST: "home.ben256.com",
                FINGERPRINT_CMD: "/home/benjamin/256/obs_fingerprint.sh"
            }
        }
    ]
};

