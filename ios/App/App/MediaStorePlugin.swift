import Foundation
import Capacitor
import AVFoundation

@objc(MediaStorePlugin)
public class MediaStorePlugin: CAPPlugin {
    
    @objc func getAudioFiles(_ call: CAPPluginCall) {
        var tracks = [[String: Any]]()
        
        // On iOS, we scan the app's Document directory (where users can drop MP3s via Files app or iTunes File Sharing)
        guard let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            call.resolve(["tracks": tracks])
            return
        }
        
        let fileManager = FileManager.default
        let keys: [URLResourceKey] = [.isRegularFileKey]
        
        guard let enumerator = fileManager.enumerator(at: documentsURL, includingPropertiesForKeys: keys) else {
            call.resolve(["tracks": tracks])
            return
        }
        
        for case let fileURL as URL in enumerator {
            let ext = fileURL.pathExtension.lowercased()
            if ext == "mp3" || ext == "m4a" || ext == "wav" || ext == "flac" || ext == "aac" || ext == "ogg" {
                let asset = AVAsset(url: fileURL)
                
                var title = fileURL.deletingPathExtension().lastPathComponent
                var artist = "Unknown Artist"
                var album = "Unknown Album"
                let duration = CMTimeGetSeconds(asset.duration)
                
                for item in asset.commonMetadata {
                    if item.commonKey == .commonKeyTitle, let stringValue = item.stringValue {
                        title = stringValue
                    }
                    if item.commonKey == .commonKeyArtist, let stringValue = item.stringValue {
                        artist = stringValue
                    }
                    if item.commonKey == .commonKeyAlbumName, let stringValue = item.stringValue {
                        album = stringValue
                    }
                }
                
                // Return exactly the same schema as the Android plugin
                let track: [String: Any] = [
                    "url": fileURL.path,
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "duration": duration.isNaN ? 180.0 : duration
                ]
                tracks.append(track)
            }
        }
        
        call.resolve(["tracks": tracks])
    }
}
