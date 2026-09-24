import sys
import re

destructure = """  const {
    theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
    activeIndex, setActiveIndex, isPlaying, setIsPlaying, progress, setProgress,
    volume, setVolume, isSeeking, tracks, setTracks, currentTrack, setCurrentTrack,
    isScanning, setIsScanning, shuffle, setShuffle, shuffleOrder, shufflePointer,
    repeat, setRepeat, slideIndex, setSlideIndex, cflowIndex, setCflowIndex,
    time, setTime, playlists, setPlaylists, selectedPlaylistName, setSelectedPlaylistName,
    selectedArtist, setSelectedArtist, selectedAlbum, setSelectedAlbum,
    selectedGenre, setSelectedGenre, searchInput, setSearchInput, searchQuery, setSearchQuery,
    selectedOptionTrack, setSelectedOptionTrack, isOptionsModalOpen, setIsOptionsModalOpen,
    isPlaylistSelectOpen, setIsPlaylistSelectOpen, isAddSongsToPlaylistOpen, setIsAddSongsToPlaylistOpen,
    editingTrack, setEditingTrack, newPlaylistName, setNewPlaylistName,
    isCreatingModalPlaylist, setIsCreatingModalPlaylist, modalPlaylistName, setModalPlaylistName,
    volDragRef, volumeOverlay, setVolumeOverlay, crossfadeDuration, setCrossfadeDuration,
    audioRefA, audioRefB, activeAudioRef, audioRef, audioCtxRef, gainARef, gainBRef, masterGainRef,
    analyserRef, sourceARef, sourceBRef, navigate, goBack, generateShuffleOrder, playTrack,
    skipNext, skipPrev, handleTimeUpdate, handleEnded, initWebAudio, togglePlayPause,
    seekTo, scanStorage, clearLibrary, getTrackGenre, saveTracks, t, timeStr, filteredTracks,
    isLandscape, handleCfTouchStart, handleCfTouchMove, handleCfTouchEnd, handleCfMouseDown,
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems
  } = props;"""

def main():
    with open('src/app/App.tsx', 'r') as f:
        lines = f.readlines()
        
    screens_to_extract = [
        "allsongs", "artists", "artistSongs", "albums", "albumSongs",
        "genres", "genreSongs", "playlists", "playlistSongs"
    ]
    
    extracted = []
    
    # We will modify the renderScreen block
    inside_render = False
    
    new_lines = []
    i = 0
    while i < len(lines):
        line = lines[i]
        
        # Are we starting an inline case?
        match = re.match(r'^      case "([a-zA-Z0-9]+)": \{', line)
        if match and match.group(1) in screens_to_extract:
            screen_name = match.group(1)
            comp_name = screen_name[0].upper() + screen_name[1:] + "Screen"
            
            # Start extracting block
            block = []
            brace_count = 1
            i += 1
            while i < len(lines):
                if '{' in lines[i]:
                    brace_count += lines[i].count('{')
                if '}' in lines[i]:
                    brace_count -= lines[i].count('}')
                
                if brace_count == 0:
                    break
                block.append(lines[i])
                i += 1
                
            # block now contains the inside of case "..." { ... }
            # Usually it starts with `return (` or some `const` statements and then `return (`
            # We wrap this block in our component
            comp_def = [
                f"const {comp_name} = (props: any) => {{\n",
                destructure + "\n"
            ]
            for b in block:
                comp_def.append(b)
            comp_def.append("}\n\n")
            
            extracted.extend(comp_def)
            
            # Now replace the case in new_lines
            new_lines.append(f'      case "{screen_name}":\n')
            new_lines.append(f'        return <{comp_name} {{...appProps}} />;\n')
            
        else:
            new_lines.append(line)
        
        i += 1
        
    # Now prepend extracted components before export default function App()
    insert_idx = -1
    for idx, l in enumerate(new_lines):
        if 'export default function App()' in l:
            insert_idx = idx
            break
            
    if insert_idx != -1:
        new_lines = new_lines[:insert_idx] + extracted + new_lines[insert_idx:]
        
    with open('src/app/App.tsx', 'w') as f:
        f.writelines(new_lines)
        
    print("Done")

if __name__ == "__main__":
    main()
