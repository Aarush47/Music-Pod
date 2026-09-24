with open('src/app/App.tsx', 'r') as f:
    content = f.read()

# Variables to remove from the destructuring string
to_remove = ['sourceARef,', 'sourceBRef,', 'playTrack,', 'togglePlayPause,', 'getTrackGenre,']

for var in to_remove:
    content = content.replace(' ' + var, '')
    content = content.replace(var + ' ', '')

with open('src/app/App.tsx', 'w') as f:
    f.write(content)

print("Fixed")
