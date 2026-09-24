package com.figma.mymusicplayer;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
