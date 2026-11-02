// sn-plugin-lib is provided by the Supernote PluginHost at runtime.
// Keep it out of the plugin's own Android build (it would pull in CMake/NDK).
module.exports = {
  dependencies: {
    'sn-plugin-lib': { platforms: { android: null, ios: null } },
  },
};
