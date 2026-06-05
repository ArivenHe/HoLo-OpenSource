

# CodeX Prompt: 3D Open Source Theme Sokoban (Push-Box) Game

## Role & Context

You are an expert Frontend & Game Developer. You need to build a high-performance, visually stunning 3D Sokoban (Push-Box) game for a university "PU Activity" organized by the **Open Atom Open Source Association (开放原子开源社团)**.

### Game Concept

Instead of traditional boxes, players push blocks containing **lines of code** (e.g., `printf("Hello, 开源！");`). The goal is to push these code blocks into their correct target slots (like completing a code snippet). Once successfully solved, the code executes/activates, and the output is displayed beautifully on the screen.

---

## Technical Stack & Constraints

To ensure high performance, excellent UI, and rapid development, adhere strictly to these constraints:

* **Framework:** React (Vite) + TypeScript
* **3D Engine:** Three.js via `@react-three/fiber` and `@react-three/drei` (Use standard 3D primitives with high-end materials/lighting to simulate 3D models efficiently, or load free GLTF models).
* **UI Library:** Ant Design (AntD) or Tailwind CSS + Shadcn/ui (Do NOT implement custom UI components from scratch).
* **State Management:** Zustand (for high-performance, low-latency game state tracking: steps, timer, grid matrix).
* **Performance:** Implement instanced meshes or optimized rendering for the 3D grid to handle smooth animations.

---

## Core Features & Game Rules

### 1. Game Mechanics (Sokoban Rules)

* **Grid System:** A 3D matrix representing the map (Walls, Floor, Player, Blocks, Target Slots).
* **Win Condition:** All code blocks must be pushed onto their corresponding target slots within the **Time Limit** AND **Step Limit**.
* **Execution Effect:** Upon winning, trigger a "Code Compiling & Executing" animation, then display the code's output (e.g., Terminal style popup showing `Hello, 开源！`).

### 2. PU Activity & Teamwork Mode

* **Team Setup:** Built for 40-50 participants divided into teams of 4.
* **Time-Attack:** The entire activity lasts under 2 hours. The game must feature:
* A prominent **Countdown Timer** (e.g., 5-10 minutes per level).
* A **Step Counter** with a strict maximum limit.
* A **Leaderboard Screen** showing Team Name, Time Elapsed, and Steps Taken to rank the teams.

### 3. Visuals & UI/UX (Cyberpunk / Open Source Style)

* **Theme:** Tech-centric, open-source geek vibe (dark mode, neon glows, terminal aesthetics).
* **UI Elements (Use External UI Library):**
* **Dashboard:** Team Info, Level Selector, Timer, Step Counter, Reset Button.
* **Victory Modal:** A sleek AntD/Shadcn dialog displaying the executed code output with a confetti effect.

* **3D Models & Effects:**
* **Player:** A stylish 3D robot or avatar.
* **Blocks:** Glowing neon cubes with code text textures mapped onto them.
* **Targets:** Holographic or glowing brackets/slots on the floor.

---

## Step-by-Step Implementation Plan

Please generate the project by following these architectural steps:

### Step 1: Project Initialization & Dependency Setup

Generate the `package.json` and project structure using Vite, React, TypeScript, Tailwind CSS, Three.js (`@react-three/fiber`), and Zustand.

### Step 2: Game State Manager (`src/store/useGameStore.ts`)

Create a Zustand store to manage:

* Current level data (map matrix).
* Player position $(x, y)$.
* Move count and Timer countdown.
* Game status (`IDLE`, `PLAYING`, `WON`, `FAILED`).
* Team registration info.

### Step 3: 3D Game Board Component (`src/components/GameBoard3D.tsx`)

Render the Sokoban map in 3D:

* Listen to keyboard arrow keys / WASD for player movement.
* Implement collision detection (cannot walk into walls, can push one block if the space behind it is empty).
* Add smooth Lerp animations for moving blocks and the player.

### Step 4: Futuristic UI Overlay (`src/components/UIOverlay.tsx`)

Use the external UI library to create the HUD (Heads-Up Display):

* Top bar with Open Atom Open Source Association branding.
* Side panel showing the target code snippet clue (e.g., `Fill in the blank: _____("Hello, 开源！");`).
* Timer and Step counter components.

### Step 5: Leaderboard & Team Management (`src/components/Leaderboard.tsx`)

A view where the activity admin or teams can see the rankings based on completion efficiency.

---

## Code Generation Directive

Now, let's start building. Please generate the **Project Structure Layout** first, followed by the core **Zustand Game State Store** and the **3D Game Board Component** to get the game mechanics working immediately.
