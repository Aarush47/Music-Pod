import sys
import re

def main():
    with open('src/app/App.tsx', 'r') as f:
        lines = f.readlines()
        
    start_idx = -1
    for i, line in enumerate(lines):
        if 'StatusBar' in line and 'const' in line:
            start_idx = i - 1
            break
            
    end_idx = -1
    for i in range(start_idx, len(lines)):
        line = lines[i]
        if 'const renderScreen = () => {' in line:
            end_idx = i
            break
            
    if start_idx == -1 or end_idx == -1:
        print("Could not find screens")
        return
        
    # Extract screens
    screens_content = lines[start_idx:end_idx]
    
    # Remove from original place
    del lines[start_idx:end_idx]
    
    # Find where to insert (before export default function App())
    insert_idx = -1
    for i, line in enumerate(lines):
        if 'export default function App()' in line:
            insert_idx = i
            break
            
    # Modify the extracted functions to accept props
    modified_content = []
    for line in screens_content:
        # Some are `const Screen = () => (` and some `const Screen = () => {`
        line = re.sub(r'const ([A-Za-z0-9_]+) = \(\) =>', r'const \1 = (props: any) =>', line)
        modified_content.append(line)
    
    # Insert
    lines = lines[:insert_idx] + modified_content + lines[insert_idx:]
    
    with open('scratch/App_hoisted.tsx', 'w') as f:
        f.writelines(lines)
        
    print("Successfully hoisted screens to scratch/App_hoisted.tsx")

if __name__ == "__main__":
    main()
