// floating-ui.js - Injects a simple debugging/control panel into the current webpage
class FloatingUI {
    constructor() {
        this.container = null;
        this.logArea = null;
        this.statusText = null;
        this.init();
    }

    init() {
        if (document.getElementById('manga-reader-float-ui')) return;

        this.container = document.createElement('div');
        this.container.id = 'manga-reader-float-ui';
        Object.assign(this.container.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            width: '350px',
            height: '400px',
            backgroundColor: 'rgba(26, 26, 46, 0.95)',
            border: '2px solid #e94560',
            borderRadius: '10px',
            color: 'white',
            fontFamily: 'sans-serif',
            zIndex: '99999999',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            overflow: 'hidden'
        });

        // Header
        const header = document.createElement('div');
        Object.assign(header.style, {
            backgroundColor: '#e94560',
            padding: '10px',
            fontWeight: 'bold',
            textAlign: 'center',
            cursor: 'move',
            userSelect: 'none'
        });
        header.innerText = 'Manga Reader UI';
        this.container.appendChild(header);

        // Status Line
        this.statusText = document.createElement('div');
        Object.assign(this.statusText.style, {
            padding: '5px 10px',
            fontSize: '12px',
            borderBottom: '1px solid #333'
        });
        this.statusText.innerText = 'Status: Waiting...';
        this.container.appendChild(this.statusText);

        // Controls
        const controls = document.createElement('div');
        Object.assign(controls.style, {
            display: 'flex',
            justifyContent: 'center',
            gap: '10px',
            padding: '10px'
        });

        const btnStyle = {
            backgroundColor: '#e94560',
            color: 'white',
            border: 'none',
            padding: '5px 15px',
            borderRadius: '5px',
            cursor: 'pointer',
            fontWeight: 'bold'
        };

        const playBtn = document.createElement('button');
        Object.assign(playBtn.style, btnStyle);
        playBtn.innerText = 'Play';
        playBtn.onclick = () => window.postMessage({ source: 'manga-reader', action: 'play' }, '*');

        const pauseBtn = document.createElement('button');
        Object.assign(pauseBtn.style, btnStyle);
        pauseBtn.innerText = 'Pause';
        pauseBtn.onclick = () => window.postMessage({ source: 'manga-reader', action: 'pause' }, '*');

        const stopBtn = document.createElement('button');
        Object.assign(stopBtn.style, btnStyle);
        stopBtn.innerText = 'Stop';
        stopBtn.onclick = () => window.postMessage({ source: 'manga-reader', action: 'stop' }, '*');

        controls.appendChild(playBtn);
        controls.appendChild(pauseBtn);
        controls.appendChild(stopBtn);
        this.container.appendChild(controls);

        // Logs Area
        this.logArea = document.createElement('div');
        Object.assign(this.logArea.style, {
            flex: 1,
            padding: '10px',
            backgroundColor: '#0f0f1a',
            overflowY: 'auto',
            fontSize: '11px',
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap'
        });
        this.container.appendChild(this.logArea);

        document.body.appendChild(this.container);
        this.makeDraggable(header, this.container);
        
        this.log('Floating UI Initialized.');
    }

    log(message) {
        if (!this.logArea) return;
        const msgDiv = document.createElement('div');
        msgDiv.style.marginBottom = '4px';
        msgDiv.innerText = `[${new Date().toLocaleTimeString().split(' ')[0]}] ${message}`;
        this.logArea.appendChild(msgDiv);
        this.logArea.scrollTop = this.logArea.scrollHeight;
    }

    setStatus(status) {
        if (this.statusText) {
            this.statusText.innerText = `Status: ${status}`;
        }
    }

    makeDraggable(header, container) {
        let isDragging = false;
        let currentX, currentY, initialX, initialY;
        let xOffset = 0, yOffset = 0;

        header.addEventListener('mousedown', dragStart);
        document.addEventListener('mouseup', dragEnd);
        document.addEventListener('mousemove', drag);

        function dragStart(e) {
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;
            isDragging = true;
        }

        function dragEnd(e) {
            initialX = currentX;
            initialY = currentY;
            isDragging = false;
        }

        function drag(e) {
            if (isDragging) {
                e.preventDefault();
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
                xOffset = currentX;
                yOffset = currentY;
                container.style.transform = `translate(${currentX}px, ${currentY}px)`;
            }
        }
    }
}

window.MangaFloatUI = FloatingUI;