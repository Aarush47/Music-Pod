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
        
    for i in range(len(lines)):
        # If it's a screen declaration
        if re.match(r'^\s*const (StatusBar|HomeScreen|ListScreen|SettingsScreen|NowPlayingScreen|CoverFlowScreen) =', lines[i]):
            # Change to accept props
            if '()' in lines[i]:
                lines[i] = lines[i].replace('()', '(props: any)')
            elif '({' in lines[i]:
                # ListScreen takes { title, items }
                pass
                
            # If it's `=> (` we change it to `=> {\n  return (`
            if '=> (' in lines[i]:
                lines[i] = lines[i].replace('=> (', '=> {\n' + destructure + '\n  return (')
            elif '=> {' in lines[i]:
                lines[i] = lines[i].replace('=> {', '=> {\n' + destructure)
                
        # Fix the ending of => ( which is now a block
        # Actually this is hard to do safely. Let's just do it manually with multi_replace for each!
