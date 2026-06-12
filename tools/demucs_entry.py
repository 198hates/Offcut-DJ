# PyInstaller entry point for a standalone Demucs CLI bundled inside Offcut.
import multiprocessing
from demucs.separate import main

if __name__ == '__main__':
    multiprocessing.freeze_support()
    main()
