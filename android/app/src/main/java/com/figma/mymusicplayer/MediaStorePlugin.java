package com.figma.mymusicplayer;

import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;

@CapacitorPlugin(
    name = "MediaStore",
    permissions = {
        @Permission(
            alias = "audio",
            strings = { "android.permission.READ_MEDIA_AUDIO" }
        ),
        @Permission(
            alias = "storage",
            strings = { "android.permission.READ_EXTERNAL_STORAGE" }
        )
    }
)
public class MediaStorePlugin extends Plugin {

    private String getAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
    }

    @PluginMethod
    public void getAudioFiles(PluginCall call) {
        String alias = getAlias();
        if (getPermissionState(alias) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias, call, "audioPermsCallback");
            return;
        }
        queryAudioFiles(call);
    }

    @PermissionCallback
    private void audioPermsCallback(PluginCall call) {
        if (getPermissionState(getAlias()) == PermissionState.GRANTED) {
            queryAudioFiles(call);
        } else {
            call.reject("Permission is required to access audio files.");
        }
    }

    private void queryAudioFiles(PluginCall call) {
        JSArray files = new JSArray();
        
        Uri uri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String[] projection = {
            MediaStore.Audio.Media.DATA,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.DURATION
        };
        
        // We want only music files
        String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0";
        
        try (Cursor cursor = getContext().getContentResolver().query(uri, projection, selection, null, null)) {
            if (cursor != null) {
                int dataColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA);
                int titleColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
                int artistColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
                int albumColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
                int durationColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
                
                while (cursor.moveToNext()) {
                    String path = cursor.getString(dataColumn);
                    if (path != null) {
                        JSObject track = new JSObject();
                        track.put("url", path);
                        track.put("title", cursor.getString(titleColumn));
                        track.put("artist", cursor.getString(artistColumn));
                        track.put("album", cursor.getString(albumColumn));
                        long durationMs = cursor.getLong(durationColumn);
                        track.put("duration", durationMs / 1000.0);
                        files.put(track);
                    }
                }
            }
        } catch (Exception e) {
            call.reject("Failed to query MediaStore", e);
            return;
        }
        
        JSObject ret = new JSObject();
        ret.put("tracks", files);
        call.resolve(ret);
    }
}
