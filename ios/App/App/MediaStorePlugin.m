#import <Capacitor/Capacitor.h>

CAP_PLUGIN(MediaStorePlugin, "MediaStore",
    CAP_PLUGIN_METHOD(getAudioFiles, CAPPluginReturnPromise);
)
