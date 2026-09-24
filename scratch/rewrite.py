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
        content = f.read()
        
    # Replace function declarations
    content = re.sub(
        r'const StatusBar = \(\) => \(',
        f'const StatusBar = (props: any) => {{\n{destructure}\n  return (',
        content
    )
    content = re.sub(
        r'    </div>\n  \);\n\n  // ── Home Screen',
        r'    </div>\n  );\n}\n\n  // ── Home Screen',
        content
    )
    
    content = re.sub(
        r'const HomeScreen = \(\) => \(',
        f'const HomeScreen = (props: any) => {{\n{destructure}\n  return (',
        content
    )
    content = re.sub(
        r'    </div>\n  \);\n\n  // ── List Screen',
        r'    </div>\n  );\n}\n\n  // ── List Screen',
        content
    )
    
    content = re.sub(
        r'const ListScreen = \(\{[\s\S]*?\}\) => \(',
        f'const ListScreen = (props: any) => {{\n{destructure}\n  const {{ title, items }} = props;\n  return (',
        content
    )
    content = re.sub(
        r'    </div>\n  \);\n\n  // ── Settings Screen',
        r'    </div>\n  );\n}\n\n  // ── Settings Screen',
        content
    )
    
    content = re.sub(
        r'const SettingsScreen = \(\) => \{',
        f'const SettingsScreen = (props: any) => {{\n{destructure}',
        content
    )
    
    content = re.sub(
        r'const NowPlayingScreen = \(\) => \{',
        f'const NowPlayingScreen = (props: any) => {{\n{destructure}',
        content
    )
    
    content = re.sub(
        r'const CoverFlowScreen = \(\) => \{',
        f'const CoverFlowScreen = (props: any) => {{\n{destructure}',
        content
    )

    # Now inside App, right before renderScreen
    app_props_decl = destructure.replace('const {', 'const appProps = {').replace('} = props;', '};')
    
    content = content.replace(
        '  const renderScreen = () => {',
        f'  const renderScreen = () => {{\n{app_props_decl}'
    )
    
    content = content.replace('return HomeScreen();', 'return <HomeScreen {...appProps} />;')
    content = content.replace('return ListScreen({ title: "Music", items: musicMenuItems });', 'return <ListScreen title="Music" items={musicMenuItems} {...appProps} />;')
    content = content.replace('return SettingsScreen();', 'return <SettingsScreen {...appProps} />;')
    content = content.replace('return NowPlayingScreen();', 'return <NowPlayingScreen {...appProps} />;')
    content = content.replace('return CoverFlowScreen();', 'return <CoverFlowScreen {...appProps} />;')
    
    with open('src/app/App.tsx', 'w') as f:
        f.write(content)

    print("Success")

if __name__ == "__main__":
    main()
