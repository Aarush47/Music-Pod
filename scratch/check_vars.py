import re

variables = """theme, setTheme, screen, setScreen, screenHistory, setScreenHistory,
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
    handleCfMouseMove, handleCfMouseUp, carouselRef, cfIsDragging, cfLastX, cfStartX, springToIndex, musicMenuItems, settingsMenuItems"""

vars_list = [v.strip() for v in variables.split(',')]

with open('src/app/App.tsx', 'r') as f:
    content = f.read()

# Only check inside App component
app_match = re.search(r'export default function App\(\) \{(.*?)\} \/\/ End of App', content, re.DOTALL)
if app_match:
    app_body = app_match.group(1)
else:
    # Just check the whole file but after line 1707
    lines = content.split('\n')
    app_body = '\n'.join(lines[1700:])

missing = []
for v in vars_list:
    v = v.replace('\n', '')
    # Check if there is a declaration: const v, let v, function v, var v, or parameter v
    if not re.search(r'\b(const|let|var|function)\s+' + v + r'\b', app_body):
        # Also could be a ref inside a destructured array `const [v, setV] = ...`
        if not re.search(r'\[.*?\b' + v + r'\b.*?\]', app_body):
            # Also check if it is declared as a function argument? (Not likely for global state)
            missing.append(v)

print("Possibly missing variables:", missing)
