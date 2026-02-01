/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    webpack: (config, { isServer }) => {
        if (!isServer) {
            config.resolve.fallback = {
                ...config.resolve.fallback,
                fs: false,
                net: false,
                tls: false,
                'pino-pretty': false,
            };
            
            // Handle react-native async storage import in MetaMask SDK
            config.resolve.alias = {
                ...config.resolve.alias,
                '@react-native-async-storage/async-storage': false,
            };
        }
        
        // Ignore optional dependencies that cause issues
        config.externals = config.externals || [];
        if (Array.isArray(config.externals)) {
            config.externals.push('pino-pretty');
        }
        
        return config;
    },
};

module.exports = nextConfig;
