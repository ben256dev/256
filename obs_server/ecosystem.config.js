module.exports = {
    apps: [
        {
            name: "obs_server",
            script: "./index.js",
            exec_mode: "fork",
            instances: 1,
            watch: false,
            out_file: "./logs/server.log",
            error_file: "./logs/server-error.log",
            env: {
                OBS_DIR: "/home/benjamin/obs_output",
                PORT: 8000,
                HOST: "home.ben256.com",
                FINGERPRINT_CMD: "/home/benjamin/256/obs_server/obs_fingerprint.sh",
                DARKMODE_CSS: "https://ben256.com/darkmode.css",
                THUMB_TIME: "00:00:03"
            }
        }
    ]
};

