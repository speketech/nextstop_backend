Overview
A high-performance, cross-platform application built with Flutter. It provides a seamless "Modern Danfo" experience for both passengers and drivers, featuring real-time map visualization and a hybrid payment system.

Key Features
Hybrid Payment Flow: Automatically switches between Native Interswitch SDK (Mobile) and Direct Webpay Redirect (Web).

Live Tracking: Google Maps integration with custom polyline routing.

Driver Wallet: Specialized UI for managing Available vs. Escrow (Pending) earnings.

Professional Networking: "Professional Snapshot" cards for co-riders to encourage in-ride networking.

State Management: BLoC pattern for predictable UI transitions.

Tech Stack
Framework: Flutter (v3.19+)

Networking: Dio (with Queued Interceptors for token refresh)

Payments: isw_mobile_sdk / url_launcher

Animations: Lottie

Storage: flutter_secure_storage

Maps: Maps_flutter

Installation
Get Packages: flutter pub get

Configure Env: Create an .env file in the root directory.

Build Web: flutter build web --release

Build Android: flutter build apk --split-per-abi

Web Deployment (Render)
To deploy the web version to https://www.google.com/search?q=cynthax.onrender.com, use the render_build.sh script:

Bash
bash render_build.sh