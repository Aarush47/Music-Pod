import sys

def main():
    with open('src/app/App.tsx', 'r') as f:
        lines = f.readlines()
        
    def find_line(text, start=0):
        for i in range(start, len(lines)):
            if text in lines[i]:
                return i
        return -1

    idx_statusbar = find_line('  // ── Status Bar ──────────────────')
    idx_render = find_line('  const renderScreen = () => {')
    
    if idx_statusbar == -1 or idx_render == -1:
        print("Could not find boundaries", idx_statusbar, idx_render)
        return
        
    screens_block = lines[idx_statusbar:idx_render]
    
    # Delete from original
    del lines[idx_statusbar:idx_render]
    
    # Insert before App
    idx_app = -1
    for i in range(len(lines)):
        if 'export default function App()' in lines[i]:
            idx_app = i
            break
            
    if idx_app == -1:
        print("Could not find App")
        return
        
    lines = lines[:idx_app] + screens_block + lines[idx_app:]
    
    with open('src/app/App.tsx', 'w') as f:
        f.writelines(lines)
        
    print("Moved screens!")

if __name__ == "__main__":
    main()
